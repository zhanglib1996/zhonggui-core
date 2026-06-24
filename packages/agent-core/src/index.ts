/**
 * @zhonggui/agent-core — Agent Loop + 会话管理 + 工具注册（聚合根）
 *
 * 本文件是所有接口类型的唯一定义位置（接口下沉模式）。
 * 其他模块（memory, skill, mcp, sandbox, model-router, logging）实现这些接口。
 */

import type { Pool, ValkeyClient, UserId, SessionId } from '@zhonggui/data';

// ════════════════════════════════════════════════════════════
// 注入接口（由下游模块实现）
// ════════════════════════════════════════════════════════════

/** M4 memory 实现 — 记忆系统 */
export interface MemoryHook {
  onMessage(sessionId: SessionId, userId: UserId, message: ChatMessage): Promise<void>;
  onSessionEnd(sessionId: SessionId, userId: UserId): Promise<void>;
  /** 编译期强制要求 userId（branded type），防止跨用户记忆泄漏 */
  recall(sessionId: SessionId, userId: UserId, query: string, topK?: number): Promise<MemoryEntry[]>;
}

/** M5 model-router 实现 — 模型路由 */
export interface ModelRouter {
  selectModel(userMessage: string, userId: string): ModelTarget;
  degrade(currentModel: string): ModelTarget;
}

/** M6 skill 实现 — Skill 加载器 */
export interface SkillLoader {
  load(userId: string): Promise<AgentTool[]>;
  loadByName(userId: string, skillName: string): Promise<AgentTool | null>;
}

/** M7 mcp 实现 — MCP 协议适配 */
export interface MCPServerAdapter {
  /** 返回当前用户可见的工具列表（按 Skill 权限过滤） */
  listTools(userId: string): Promise<AgentTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** M8 sandbox 实现 — 代码执行沙箱 */
export interface SandboxProvider {
  runPython(code: string, opts?: ExecOptions): Promise<ExecResult>;
  runShell(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  runNode(code: string, opts?: ExecOptions): Promise<ExecResult>;
}

/** M11 logging 实现 — 日志审计 */
export interface Logger {
  operation(userId: string, action: string, target: string, detail?: Record<string, unknown>): void;
  token(userId: string, model: string, inputTokens: number, outputTokens: number): void;
  error(traceId: string, userId: string, err: Error, context?: Record<string, unknown>): void;
  audit(userId: string, action: string, before: unknown, after: unknown): void;
}

// ════════════════════════════════════════════════════════════
// 中间件接口（参考 NexAU 的 Hooks/Middleware 设计）
// ════════════════════════════════════════════════════════════

/** 中间件上下文 */
export interface MiddlewareContext {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  tools: AgentTool[];
  metadata: Record<string, unknown>;
}

/** LLM 调用结果 */
export interface LLMResult {
  message: ChatMessage;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** 工具调用上下文 */
export interface ToolContext {
  sessionId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** Agent 中间件接口 */
export interface AgentMiddleware {
  name: string;

  /** 模型调用前（便捷钩子，等价于在 wrapModelCall 中调用 next 前修改 context） */
  beforeModelCall?(context: MiddlewareContext): Promise<MiddlewareContext>;
  /** 模型调用后（便捷钩子，等价于在 wrapModelCall 中调用 next 后修改 result） */
  afterModelCall?(context: MiddlewareContext, result: LLMResult): Promise<LLMResult>;
  /** 工具调用前 */
  beforeToolCall?(context: ToolContext): Promise<ToolContext>;
  /** 工具调用后 */
  afterToolCall?(context: ToolContext, result: unknown): Promise<unknown>;

  /** 嵌套 wrap 模式 — 可拦截整个模型调用生命周期（优先级高于 before/after） */
  wrapModelCall?(context: MiddlewareContext, next: () => Promise<LLMResult>): Promise<LLMResult>;
  /** 嵌套 wrap 模式 — 可拦截整个工具调用生命周期（优先级高于 before/after） */
  wrapToolCall?(context: ToolContext, next: () => Promise<unknown>): Promise<unknown>;

  onError?(error: Error, context: MiddlewareContext): Promise<void>;
  onStreamEvent?(event: StreamEvent): Promise<StreamEvent | null>;
}

// ════════════════════════════════════════════════════════════
// 追踪器接口（参考 NexAU 的 Tracer 设计）
// ════════════════════════════════════════════════════════════

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: TraceEvent[];
}

export interface TraceEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, unknown>;
}

export interface Tracer {
  name: string;
  startTrace(name: string, attributes?: Record<string, unknown>): string;
  endTrace(traceId: string): void;
  traceAgentRun(traceId: string, input: string, attributes?: Record<string, unknown>): void;
  traceLLMCall(traceId: string, model: string, messages: ChatMessage[], result: LLMResult, durationMs: number): void;
  traceToolCall(traceId: string, toolName: string, args: unknown, result: unknown, durationMs: number): void;
  traceError(traceId: string, error: Error, context?: Record<string, unknown>): void;
  traceEvent(traceId: string, name: string, attributes?: Record<string, unknown>): void;
  getTrace(traceId: string): TraceSpan[] | undefined;
}

// ════════════════════════════════════════════════════════════
// 上下文管理器接口
// ════════════════════════════════════════════════════════════

export interface ContextManager {
  countTokens(messages: ChatMessage[]): number;
  compactContext(messages: ChatMessage[], maxTokens: number): ChatMessage[];
  needsCompaction(messages: ChatMessage[], maxTokens: number): boolean;
}

// ════════════════════════════════════════════════════════════
// 核心类型
// ════════════════════════════════════════════════════════════

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  timestamp: Date;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  source?: 'l0' | 'l1' | 'l2';
}

export interface ModelTarget {
  provider: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export interface ExecOptions {
  timeout?: number;
  maxMemory?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  oom: boolean;
}

export type StreamEventType =
  | 'text'            // 完整文本响应
  | 'text_delta'      // 流式文本片段
  | 'thinking'        // 思考过程（CoT）
  | 'tool_call'       // 工具调用
  | 'tool_call_start' // 工具开始执行
  | 'tool_call_end'   // 工具执行完成
  | 'tool_result'     // 工具结果
  | 'run_start'       // Agent Loop 开始
  | 'run_end'         // Agent Loop 结束
  | 'context_compact' // 上下文压缩
  | 'error'           // 错误
  | 'done';           // 完成

export interface StreamEvent {
  type: StreamEventType;
  content: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  code?: string;
  message?: string;
  totalTokens?: number;
  modelUsed?: string;
  thinking?: string;
  traceId?: string;
  tools?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, sandbox: SandboxProvider) => Promise<unknown>;
  /** 可选格式化器 — 分离 LLM 内容和前端展示内容 */
  formatter?: (result: unknown) => { llm: string; display?: string };
  /** 可选元数据 — Skill YAML 中的 model 等扩展字段 */
  metadata?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════
// 会话管理
// ════════════════════════════════════════════════════════════

export interface Session {
  id: string;
  userId: string;
  title?: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionSummary {
  id: string;
  title?: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionManager {
  create(userId: string): Promise<string>;
  resume(sessionId: string): Promise<Session | null>;
  destroy(sessionId: string): Promise<void>;
  list(userId: string, limit?: number, offset?: number): Promise<SessionSummary[]>;
  addMessage(sessionId: string, message: ChatMessage): Promise<void>;
  getMessages(sessionId: string): Promise<ChatMessage[]>;
}

// ════════════════════════════════════════════════════════════
// 工具注册中心
// ════════════════════════════════════════════════════════════

export interface ToolRegistry {
  register(tool: AgentTool): void;
  get(name: string): AgentTool | undefined;
  list(): AgentTool[];
}

// ════════════════════════════════════════════════════════════
// Agent 运行时
// ════════════════════════════════════════════════════════════

/** 构造注入配置 */
export interface AgentOptions {
  // 必填
  baseModel: ModelTarget;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  sandbox: SandboxProvider;

  // 可选注入
  memoryHook?: MemoryHook;
  skillLoader?: SkillLoader;
  mcpServer?: MCPServerAdapter;
  modelRouter?: ModelRouter;
  logger?: Logger;

  // 新增：中间件和追踪器
  middlewares?: AgentMiddleware[];
  tracers?: Tracer[];
  contextManager?: ContextManager;

  // Agent 级模型覆盖（优先级低于工具级，高于全局默认）
  overrideModel?: string;

  // 调优参数
  maxToolCalls?: number;         // 单轮最大工具调用，默认 10
  maxConversationTurns?: number; // 单次对话最大轮次，默认 50
  maxContextTokens?: number;     // 最大上下文 Token 数，默认 100000
  maxToolConcurrency?: number;   // 单轮工具并行执行数，默认 5（设为 1 则串行）
  systemPrompt?: string;         // 系统提示词
}

/** Agent 运行时实例 */
export interface AgentRuntime {
  chat(sessionId: SessionId, userId: UserId, message: string, signal?: AbortSignal, overrideModel?: string): AsyncGenerator<StreamEvent>;
  getAvailableTools(sessionId: SessionId, userId: UserId): Promise<AgentTool[]>;

  // ★ register* 运行时挂载（灵活扩展，不修改 AgentOptions 类型）★
  registerMemoryHook(hook: MemoryHook): void;
  registerModelProvider(provider: ModelRouter): void;
  registerSkillLoader(loader: SkillLoader): void;
  registerMCPServer(server: MCPServerAdapter): void;
  registerTool(tool: AgentTool): void;
  registerLogger(logger: Logger): void;

  // 新增：中间件和追踪器注册
  registerMiddleware(middleware: AgentMiddleware): void;
  registerTracer(tracer: Tracer): void;
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export { createAgentRuntime } from './runtime.js';
export { createSessionManager } from './session.js';
export { createToolRegistry } from './tool-registry.js';

// 中间件系统
export {
  MiddlewareChain,
  LoggingMiddleware,
  TimingMiddleware,
  createMiddlewareChain,
  createLoggingMiddleware,
  createTimingMiddleware,
} from './middleware.js';

// 追踪系统
export {
  ConsoleTracer,
  TracerManager,
  createConsoleTracer,
  createTracerManager,
} from './tracer.js';

// 上下文管理器
export {
  DefaultContextManager,
  createContextManager,
  estimateTokens,
  countMessageTokens,
} from './context-manager.js';

// 工具系统（参考 NexAU 的 Tool.from_yaml() 设计）
export {
  Tool,
  ToolCollection,
  createTool,
  createToolCollection,
} from './tool.js';
export type { ToolBinding, ToolDefinition } from './tool.js';

// YAML 解析器
export {
  parseYAML,
  parseToolYAML,
  parseToolYAMLContent,
  parseSkillMarkdown,
  parseSkillMarkdownContent,
  resolveEnvVars,
  mergeExtraKwargs,
} from './yaml-parser.js';
export type {
  ToolYAMLDefinition,
  SkillFrontmatter,
  SkillMetadata,
  SkillToolMetadata,
} from './yaml-parser.js';

// 内置工具
export {
  loadBuiltinTools,
  loadBuiltinToolCollection,
  createBuiltinTool,
} from './builtin-tools.js';

// 故障转移中间件
export {
  LLMFailoverMiddleware,
  createLLMFailoverMiddleware,
} from './failover-middleware.js';
export type { FailoverProvider, LLMFailoverMiddlewareOptions } from './failover-middleware.js';

// AgentFactory — DB 驱动的 AgentRuntime 工厂
export {
  AgentFactory,
  createAgentFactory,
} from './agent-factory.js';

// PostgresTracer — 持久化追踪器
export {
  PostgresTracer,
  createPostgresTracer,
} from './postgres-tracer.js';

// 沙箱策略双层防护
export {
  SandboxPolicyMiddleware,
  PolicyEnforcedSandbox,
  createSandboxPolicyMiddleware,
  createPolicyEnforcedSandbox,
} from './sandbox-policy.js';

// Re-export branded types from data
export type { UserId, SessionId } from '@zhonggui/data';

// 扩展 ModelTarget 支持 baseURL 和 apiKey
