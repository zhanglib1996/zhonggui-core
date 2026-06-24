/**
 * Agent Loop 主循环
 * 思考 → 工具调用 → 结果注入 → 流式输出
 *
 * 参考 NexAU 设计，新增：
 * - 中间件系统（Hooks/Middleware）
 * - 追踪系统（Tracer）
 * - 上下文管理（Context Compaction）
 */

import { nanoid } from 'nanoid';
import type { UserId, SessionId } from '@zhonggui/data';
import type {
  AgentOptions,
  AgentRuntime,
  AgentTool,
  ChatMessage,
  MemoryHook,
  ModelRouter,
  SkillLoader,
  MCPServerAdapter,
  Logger,
  StreamEvent,
  ToolCall,
  AgentMiddleware,
  Tracer,
  ContextManager,
  MiddlewareContext,
  ToolContext,
  LLMResult,
} from './index.js';
import { MiddlewareChain } from './middleware.js';
import { TracerManager, createConsoleTracer } from './tracer.js';
import { createContextManager } from './context-manager.js';

// ─── StreamBridge — 桥接 SSE 流式解析和 AsyncGenerator ───

// P1-3: SSEChunk 类型安全接口
interface SSEChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

class StreamBridge {
  private queue: Array<{ type: 'delta'; text: string } | { type: 'done' }> = [];
  private waiting: Array<() => void> = [];
  private drainWaiting: Array<() => void> = [];
  private static readonly HIGH_WATER_MARK = 1000;

  /** 推送一个 text_delta（由 callLLM 内部 SSE 解析调用） */
  async pushTextDelta(text: string): Promise<void> {
    // 背压: 队列超过高水位标记时，等待消费者消费
    if (this.queue.length >= StreamBridge.HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => this.drainWaiting.push(resolve));
    }
    this.queue.push({ type: 'delta', text });
    this.flush();
  }

  /** 标记流结束 */
  finish(): void {
    this.queue.push({ type: 'done' });
    this.flush();
  }

  private flush(): void {
    while (this.waiting.length > 0) {
      this.waiting.shift()!();
    }
    // 当队列降到高水位一半以下时，唤醒等待的生产者
    if (this.queue.length < StreamBridge.HIGH_WATER_MARK / 2) {
      while (this.drainWaiting.length > 0) {
        this.drainWaiting.shift()!();
      }
    }
  }

  /** 异步迭代器 — agentLoop 用 for await 消费 text_delta */
  async *events(): AsyncGenerator<string> {
    while (true) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      }
      const item = this.queue.shift()!;
      if (item.type === 'done') return;
      yield item.text;
    }
  }
}

// ─── 默认系统提示词 ───

const DEFAULT_SYSTEM_PROMPT = `你是一个有用的 AI 助手。你可以使用工具来帮助用户完成任务。
当需要执行代码时，使用 Python 或 Node.js 工具。
回答要简洁、准确、有帮助。`;

// ─── K1 fix: 内部 ToolCall[] → OpenAI API format ───
function formatToolCallsForAPI(toolCalls: ToolCall[]) {
  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
}

// ─── 创建 Agent 运行时 ───

export function createAgentRuntime(options: AgentOptions): AgentRuntime {
  const {
    baseModel,
    sessionManager,
    toolRegistry,
    sandbox,
    maxToolCalls = 10,
    maxConversationTurns = 50,
    maxContextTokens = 100000,
    maxToolConcurrency = 5,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    overrideModel,
  } = options;

  // 运行时可变状态（register* 挂载）
  let memoryHook: MemoryHook | undefined = options.memoryHook;
  let skillLoader: SkillLoader | undefined = options.skillLoader;
  let mcpServer: MCPServerAdapter | undefined = options.mcpServer;
  let modelRouter: ModelRouter | undefined = options.modelRouter;
  let logger: Logger | undefined = options.logger;
  let currentModel = baseModel;

  // 新增：中间件链
  const middlewareChain = new MiddlewareChain(options.middlewares || []);

  // 新增：追踪器管理器
  const tracerManager = new TracerManager(options.tracers || [createConsoleTracer()]);

  // 新增：上下文管理器
  const contextManager: ContextManager = options.contextManager || createContextManager();

  // ─── 内置工具注册 ───

  // 代码执行工具
  toolRegistry.register({
    name: 'run_python',
    description: '执行 Python 代码并返回结果。适用于数据计算、文件处理等任务。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Python 代码' },
      },
      required: ['code'],
    },
    async execute(args, sb) {
      const code = args.code as string;
      const result = await sb.runPython(code);
      if (result.timedOut) return { error: 'Execution timed out', durationMs: result.durationMs };
      if (result.oom) return { error: 'Out of memory', durationMs: result.durationMs };
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
    },
  });

  toolRegistry.register({
    name: 'run_shell',
    description: '执行 Shell 命令并返回结果。适用于系统操作、文件管理等任务。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 Shell 命令' },
      },
      required: ['command'],
    },
    async execute(args, sb) {
      const command = args.command as string;
      const result = await sb.runShell(command);
      if (result.timedOut) return { error: 'Execution timed out', durationMs: result.durationMs };
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
    },
  });

  toolRegistry.register({
    name: 'run_node',
    description: '执行 Node.js 代码并返回结果。适用于 JavaScript/TypeScript 任务。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 Node.js 代码' },
      },
      required: ['code'],
    },
    async execute(args, sb) {
      const code = args.code as string;
      const result = await sb.runNode(code);
      if (result.timedOut) return { error: 'Execution timed out', durationMs: result.durationMs };
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs: result.durationMs };
    },
  });

  // ─── LLM 调用（集成中间件和追踪器）───

  async function callLLM(
    messages: Array<{ role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }>,
    tools: AgentTool[],
    userId: string,
    sessionId: string,
    options?: { bridge?: StreamBridge; overrideModel?: string; signal?: AbortSignal },
  ): Promise<LLMResult> {
    const middlewareContext: MiddlewareContext = {
      sessionId,
      userId,
      messages: messages.map((m) => ({
        id: nanoid(),
        role: m.role as ChatMessage['role'],
        content: m.content,
        toolCalls: m.tool_calls,
        toolCallId: m.tool_call_id,
        timestamp: new Date(),
      })),
      tools,
      metadata: {},
    };

    // 使用 wrap 钩子执行 LLM 调用（内部自动处理 before/after 降级）
    const result = await middlewareChain.executeWrapModelCall(middlewareContext, async () => {
      const lastUserMsg = middlewareContext.messages.findLast((m) => m.role === 'user')?.content ?? '';

      // 改造 2: overrideModel 优先级 — 工具级 > Agent级 > 全局默认
      let model = modelRouter?.selectModel(lastUserMsg, userId) ?? currentModel;

      // 如果指定了 overrideModel，使用它
      if (options?.overrideModel) {
        // 根据模型名称设置对应的 baseURL
        let overrideBaseURL = currentModel.baseURL;
        if (options.overrideModel.includes('qwen') || options.overrideModel.includes('ollama')) {
          overrideBaseURL = 'http://localhost:11434/v1';
        }
        model = { ...currentModel, model: options.overrideModel, baseURL: overrideBaseURL };
      }

      const body: Record<string, unknown> = {
        model: model.model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...middlewareContext.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.toolCalls ? { tool_calls: formatToolCallsForAPI(m.toolCalls) } : {}),
            ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          })),
        ],
        stream: true,
      };

      if (middlewareContext.tools.length > 0) {
        body.tools = middlewareContext.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const baseURL = model.baseURL ?? 'https://api.openai.com/v1';
      const apiKey = model.apiKey ?? process.env.OPENAI_API_KEY ?? '';
      const startTime = Date.now();

      // 改造 4: AbortSignal.timeout(60s) + 外部 signal
      const timeoutSignal = AbortSignal.timeout(60_000);
      const combinedSignal = options?.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: apiKey ? { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } : { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[LLM] API error ${response.status}: ${errText}`);
        throw new Error(`LLM API error ${response.status}`);
      }

      // 改造 1: SSE 流式解析
      const bridge = options?.bridge;
      let fullContent = '';
      let toolCallsRaw: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
      let usageData: { prompt_tokens: number; completion_tokens: number } | undefined;

      // 累积 tool_calls delta 的缓冲区
      const tcBuffer: Map<number, { id: string; type: string; function: { name: string; arguments: string } }> = new Map();

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is not readable');

      const decoder = new TextDecoder();
      let sseBuffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) continue;
            if (trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            const jsonStr = trimmed.slice(6);
            let chunk: SSEChunk;
            try {
              chunk = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            // 提取 usage（部分 API 在最后一个 chunk 返回）
            if (chunk.usage) {
              usageData = chunk.usage;
            }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta ?? {};

            // 累积 content delta
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              fullContent += delta.content;
              await bridge?.pushTextDelta(delta.content);
            }

            // 累积 tool_calls delta
            if (Array.isArray(delta.tool_calls)) {
              for (const tcDelta of delta.tool_calls) {
                const idx = tcDelta.index ?? 0;
                if (!tcBuffer.has(idx)) {
                  tcBuffer.set(idx, { id: tcDelta.id ?? '', type: tcDelta.type ?? 'function', function: { name: '', arguments: '' } });
                }
                const entry = tcBuffer.get(idx)!;
                if (tcDelta.id) entry.id = tcDelta.id;
                if (tcDelta.type) entry.type = tcDelta.type;
                if (tcDelta.function?.name) entry.function.name += tcDelta.function.name;
                if (tcDelta.function?.arguments) entry.function.arguments += tcDelta.function.arguments;
              }
            }
          }
        }
      } finally {
        bridge?.finish();
        reader.releaseLock();
      }

      // 将累积的 tool_calls 转换为最终格式
      toolCallsRaw = [...tcBuffer.values()].filter((tc) => tc.function.name.length > 0);

      const durationMs = Date.now() - startTime;

      if (usageData && logger) {
        logger.token(userId, model.model, usageData.prompt_tokens, usageData.completion_tokens);
      }

      const toolCalls = toolCallsRaw.map((tc) => ({
        id: tc.id || nanoid(),
        name: tc.function.name,
        arguments: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })() as Record<string, unknown>,
      }));

      const llmResult: LLMResult = {
        message: {
          id: nanoid(),
          role: 'assistant',
          content: fullContent,
          toolCalls,
          timestamp: new Date(),
        },
        usage: usageData
          ? { inputTokens: usageData.prompt_tokens, outputTokens: usageData.completion_tokens }
          : undefined,
      };

      tracerManager.traceLLMCall(sessionId, model.model, middlewareContext.messages, llmResult, durationMs);
      return llmResult;
    });

    return result;
  }

  // ─── Agent Loop 主循环（集成中间件、追踪器、上下文管理）───

  async function* agentLoop(
    sessionId: SessionId,
    userId: UserId,
    userMessage: string,
    signal?: AbortSignal,
    overrideModel?: string,
  ): AsyncGenerator<StreamEvent> {
    // 0. 开始追踪
    const traceId = tracerManager.startTrace('agent_loop', { sessionId, userId });
    tracerManager.traceAgentRun(traceId, userMessage);

    try {
      // 1. 加载会话历史
      const session = await sessionManager.resume(sessionId);
      if (!session) {
        const event: StreamEvent = { type: 'error', content: '', message: `Session ${sessionId} not found` };
        tracerManager.traceError(traceId, new Error(event.message));
        yield event;
        return;
      }

      // 2. 检查轮次限制
      const userTurns = session.messages.filter((m) => m.role === 'user').length;
      if (userTurns >= maxConversationTurns) {
        const event: StreamEvent = { type: 'error', content: '', message: `Conversation turn limit reached (${maxConversationTurns})` };
        yield event;
        return;
      }

      // 3. 记录用户消息
      const userMsg: ChatMessage = {
        id: nanoid(),
        role: 'user',
        content: userMessage,
        timestamp: new Date(),
      };
      await sessionManager.addMessage(sessionId, userMsg);

      // 4. 触发记忆钩子
      if (memoryHook) {
        await memoryHook.onMessage(sessionId, userId, userMsg);
      }

      // 5. 获取记忆上下文
      let memoryContext = '';
      if (memoryHook) {
        const memories = await memoryHook.recall(sessionId, userId, userMessage, 5);
        if (memories.length > 0) {
          memoryContext = '\n\n[相关记忆]\n' + memories.map((m) => `- ${m.content}`).join('\n');
        }
      }

      // 6. 加载可用工具
      const allTools = await loadAllTools(userId);

      // 6.5 yield run_start 事件
      yield {
        type: 'run_start',
        content: userMessage,
        tools: allTools.map((t) => t.name),
        traceId,
      };

      // 7. 构建消息历史（注入记忆上下文）
      const messages: Array<{ role: string; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }> = [
        ...session.messages.slice(0, -1).map((m) => ({
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls,
          tool_call_id: m.toolCallId,
        })),
        {
          role: 'user',
          content: userMessage + memoryContext,
        },
      ];

      // 8. 上下文压缩检查
      const chatMessages: ChatMessage[] = messages.map((m) => ({
        id: nanoid(),
        role: m.role as ChatMessage['role'],
        content: m.content,
        toolCalls: m.tool_calls,
        toolCallId: m.tool_call_id,
        timestamp: new Date(),
      }));
      if (contextManager.needsCompaction(chatMessages, maxContextTokens)) {
        tracerManager.traceEvent(traceId, 'context_compaction', { maxTokens: maxContextTokens });
        const compacted = contextManager.compactContext(chatMessages, maxContextTokens);
        messages.length = 0;
        messages.push(
          ...compacted.map((m) => ({
            role: m.role,
            content: m.content,
            tool_calls: m.toolCalls,
            tool_call_id: m.toolCallId,
          })),
        );
        yield {
          type: 'context_compact',
          content: '',
          message: `Context compacted: ${chatMessages.length} → ${compacted.length} messages`,
          traceId,
        };
      }

      // 9. Agent Loop — 最多 maxToolCalls 轮工具调用
      let toolCallCount = 0;
      // 改造 3: 降级死循环计数器
      let degradeCount = 0;
      const MAX_DEGRADE = 3;
      // 改造 2: 工具级 overrideModel（跨迭代传递）
      let pendingOverrideModel: string | undefined;

      while (toolCallCount < maxToolCalls) {
        let llmResult: { message: ChatMessage; usage?: { inputTokens: number; outputTokens: number } };

        // 改造 6: 检查外部信号是否已中止
        if (signal?.aborted) {
          yield { type: 'error', content: '', message: 'Request aborted by client' };
          return;
        }

        try {
          // 改造 2: 优先级 工具级 > Agent级 > 全局默认

          const effectiveOverride = pendingOverrideModel ?? overrideModel ?? options?.overrideModel;
          pendingOverrideModel = undefined; // 重置

          // 改造 1: 创建 StreamBridge 并发消费 SSE 流
          const bridge = new StreamBridge();

          // 启动 callLLM（会通过 bridge 推送 text_delta）
          const llmPromise = callLLM(messages, allTools, userId, sessionId as string, {
            bridge,
            overrideModel: effectiveOverride,
            signal,
          }).catch((err) => {
            // LLM 调用失败时，确保 bridge 关闭，否则 events() 会永远挂起
            bridge.finish();
            throw err;
          });

          // 通过 bridge 实时 yield text_delta 事件
          for await (const delta of bridge.events()) {
            yield { type: 'text_delta', content: delta };
          }

          llmResult = await llmPromise;
        } catch (err) {
          // 模型降级（改造 3: 加入计数器检查）
          if (modelRouter) {
            if (degradeCount >= MAX_DEGRADE) {
              tracerManager.traceError(traceId, new Error('Max degrade limit reached'));
              yield { type: 'error', content: '', message: `模型降级次数超限 (${MAX_DEGRADE})，停止重试` };
              return;
            }
            try {
              degradeCount++;
              currentModel = modelRouter.degrade(currentModel.model);
              tracerManager.traceEvent(traceId, 'model_degrade', { model: currentModel.model });
              yield { type: 'text', content: '', message: `模型降级至 ${currentModel.model}` };
              continue;
            } catch {
              // 降级也失败
            }
          }
          const error = err as Error;
          tracerManager.traceError(traceId, error);
          const middlewareCtx: MiddlewareContext = {
            sessionId: sessionId as string,
            userId: userId as string,
            messages: [],
            tools: allTools,
            metadata: {},
          };
          await middlewareChain.executeOnError(error, middlewareCtx);
          yield { type: 'error', content: '', message: error.message };
          return;
        }

        const assistantMsg = llmResult.message;

        // 记录助手消息
        await sessionManager.addMessage(sessionId, assistantMsg);
        messages.push({
          role: 'assistant',
          content: assistantMsg.content,
          tool_calls: assistantMsg.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        });

        // 如果没有工具调用，输出文本并结束
        if (!assistantMsg.toolCalls || assistantMsg.toolCalls.length === 0) {
          const textEvent: StreamEvent = { type: 'text', content: assistantMsg.content };
          yield textEvent;
          const totalTokens = llmResult.usage
            ? llmResult.usage.inputTokens + llmResult.usage.outputTokens
            : undefined;
          yield { type: 'run_end', content: '', totalTokens, modelUsed: currentModel.model, traceId };
          yield { type: 'done', content: '', totalTokens, modelUsed: currentModel.model };
          tracerManager.endTrace(traceId);
          return;
        }

        // 执行工具调用（并行执行，受 maxToolConcurrency 限制）
        toolCallCount++;
        const toolCallsToExecute = assistantMsg.toolCalls;

        // yield tool_call + tool_call_start 事件
        for (const toolCall of toolCallsToExecute) {
          yield { type: 'tool_call', content: '', tool: toolCall.name, args: toolCall.arguments };
          yield { type: 'tool_call_start', content: '', tool: toolCall.name, args: toolCall.arguments, traceId };
        }

        // 并行执行工具调用（使用 wrap 钩子）
        const executeOneTool = async (toolCall: ToolCall) => {
          const toolContext: ToolContext = {
            sessionId: sessionId as string,
            userId: userId as string,
            toolName: toolCall.name,
            args: toolCall.arguments,
            metadata: {},
          };
          const startTime = Date.now();
          const result = await middlewareChain.executeWrapToolCall(toolContext, async () => {
            const tool = toolRegistry.get(toolCall.name);
            try {
              if (tool) {
                return await tool.execute(toolContext.args, sandbox);
              } else if (mcpServer) {
                return await mcpServer.callTool(toolCall.name, toolContext.args);
              } else {
                return { error: `Tool "${toolCall.name}" not found` };
              }
            } catch (err) {
              const errorObj = err instanceof Error ? err : new Error(String(err));
              tracerManager.traceError(traceId, errorObj, { toolName: toolCall.name });
              return {
                error: `[${errorObj.name || 'Error'}] Tool "${toolCall.name}" execution failed: ${errorObj.message || 'Unknown error'}`,
              };
            }
          });
          const durationMs = Date.now() - startTime;
          tracerManager.traceToolCall(traceId, toolCall.name, toolContext.args, result, durationMs);
          return { toolCall, result, durationMs };
        };

        // 分批并行执行
        const toolResults: Array<{ toolCall: ToolCall; result: unknown; durationMs: number }> = [];
        for (let i = 0; i < toolCallsToExecute.length; i += maxToolConcurrency) {
          const batch = toolCallsToExecute.slice(i, i + maxToolConcurrency);
          const batchResults = await Promise.all(batch.map(executeOneTool));
          toolResults.push(...batchResults);
        }

        // yield tool_call_end + tool_result 事件并记录消息
        for (const { toolCall, result, durationMs } of toolResults) {
          yield { type: 'tool_call_end', content: '', tool: toolCall.name, result, durationMs, traceId };
          yield { type: 'tool_result', content: '', tool: toolCall.name, result, durationMs };

          // 使用 formatter 分离 LLM 内容和展示内容
          const tool = toolRegistry.get(toolCall.name);
          let llmContent: string;
          if (tool?.formatter) {
            try {
              const formatted = tool.formatter(result);
              llmContent = formatted.llm;
            } catch {
              llmContent = typeof result === 'string' ? result : JSON.stringify(result);
            }
          } else {
            llmContent = typeof result === 'string' ? result : JSON.stringify(result);
          }

          const toolResultMsg: ChatMessage = {
            id: nanoid(),
            role: 'tool',
            content: llmContent,
            toolCallId: toolCall.id,
            timestamp: new Date(),
          };
          await sessionManager.addMessage(sessionId, toolResultMsg);
          messages.push({
            role: 'tool',
            content: toolResultMsg.content,
            tool_calls: undefined,
            tool_call_id: toolCall.id,
          });
        }

        // 改造 2: 从工具元数据提取下一轮 overrideModel
        for (const { toolCall } of toolResults) {
          const tool = toolRegistry.get(toolCall.name);
          if (tool?.metadata?.model) {
            pendingOverrideModel = tool.metadata.model as string;
            break; // 取第一个有 model 元数据的工具
          }
        }
      }

      // 工具调用次数超限
      const limitEvent: StreamEvent = { type: 'error', content: '', message: `Tool call limit reached (${maxToolCalls})` };
      tracerManager.traceError(traceId, new Error(limitEvent.message));
      yield limitEvent;
    } finally {
      // P1-6: 在 agentLoop 结束时调用 onSessionEnd，将 L0 热记忆持久化到 L1
      if (memoryHook?.onSessionEnd) {
        try {
          await memoryHook.onSessionEnd(sessionId, userId);
        } catch (err) {
          console.error('[MemoryHook] onSessionEnd failed:', (err as Error).message);
        }
      }
      // 结束追踪
      tracerManager.endTrace(traceId);
    }
  }

  // ─── 加载所有工具 ───

  async function loadAllTools(userId: string): Promise<AgentTool[]> {
    const tools = [...toolRegistry.list()];

    if (skillLoader) {
      try {
        const skillTools = await skillLoader.load(userId);
        tools.push(...skillTools);
      } catch (err) {
        console.warn('Failed to load skill tools:', (err as Error).message);
      }
    }

    if (mcpServer) {
      try {
        const mcpTools = await mcpServer.listTools(userId);
        tools.push(...mcpTools);
      } catch (err) {
        console.warn('Failed to load MCP tools:', (err as Error).message);
      }
    }

    return tools;
  }

  // ─── 返回 AgentRuntime 接口 ───

  return {
    chat: (sessionId, userId, message, signal?: AbortSignal, overrideModel?: string) => agentLoop(sessionId, userId, message, signal, overrideModel),

    async getAvailableTools(sessionId, userId) {
      return loadAllTools(userId);
    },

    registerMemoryHook(hook) {
      memoryHook = hook;
    },
    registerModelProvider(provider) {
      modelRouter = provider;
    },
    registerSkillLoader(loader) {
      skillLoader = loader;
    },
    registerMCPServer(server) {
      mcpServer = server;
    },
    registerTool(tool) {
      toolRegistry.register(tool);
    },
    registerLogger(log) {
      logger = log;
    },
    registerMiddleware(middleware) {
      middlewareChain.use(middleware);
    },
    registerTracer(tracer) {
      tracerManager.add(tracer);
    },
  };
}
