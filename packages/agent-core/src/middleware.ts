/**
 * 中间件系统 — 参考 NexAU 的 Hooks/Middleware 设计
 *
 * 支持在 Agent Loop 的关键节点插入自定义逻辑：
 * - beforeModelCall: 模型调用前（修改消息、注入上下文）
 * - afterModelCall: 模型调用后（修改响应、记录指标）
 * - beforeToolCall: 工具调用前（参数校验、权限检查）
 * - afterToolCall: 工具调用后（结果过滤、缓存）
 * - onError: 错误处理（降级、重试、告警）
 */

import type { ChatMessage, AgentTool, StreamEvent, MiddlewareContext, LLMResult, ToolContext } from './index.js';

// Re-export types so downstream modules (tracer.ts etc.) can import from middleware.js
export type { MiddlewareContext, LLMResult, ToolContext };

// ════════════════════════════════════════════════════════════
// 中间件接口定义
// ════════════════════════════════════════════════════════════

/** Agent 中间件接口 */
export interface AgentMiddleware {
  name: string;

  /** 模型调用前 */
  beforeModelCall?(context: MiddlewareContext): Promise<MiddlewareContext>;

  /** 模型调用后 */
  afterModelCall?(context: MiddlewareContext, result: LLMResult): Promise<LLMResult>;

  /** 工具调用前 */
  beforeToolCall?(context: ToolContext): Promise<ToolContext>;

  /** 工具调用后 */
  afterToolCall?(context: ToolContext, result: unknown): Promise<unknown>;

  /** 嵌套 wrap 模式 — 可拦截整个模型调用生命周期（优先级高于 before/after） */
  wrapModelCall?(context: MiddlewareContext, next: () => Promise<LLMResult>): Promise<LLMResult>;

  /** 嵌套 wrap 模式 — 可拦截整个工具调用生命周期（优先级高于 before/after） */
  wrapToolCall?(context: ToolContext, next: () => Promise<unknown>): Promise<unknown>;

  /** 错误处理 */
  onError?(error: Error, context: MiddlewareContext): Promise<void>;

  /** 流式事件处理 */
  onStreamEvent?(event: StreamEvent): Promise<StreamEvent | null>;
}

// ════════════════════════════════════════════════════════════
// 中间件链实现
// ════════════════════════════════════════════════════════════

export class MiddlewareChain {
  private middlewares: AgentMiddleware[] = [];

  constructor(middlewares: AgentMiddleware[] = []) {
    this.middlewares = [...middlewares];
  }

  /** 添加中间件 */
  use(middleware: AgentMiddleware): void {
    this.middlewares.push(middleware);
  }

  /** 移除中间件 */
  remove(name: string): void {
    this.middlewares = this.middlewares.filter((m) => m.name !== name);
  }

  /** 获取所有中间件 */
  list(): AgentMiddleware[] {
    return [...this.middlewares];
  }

  /** 执行 beforeModelCall 链 */
  async executeBeforeModelCall(context: MiddlewareContext): Promise<MiddlewareContext> {
    let ctx = { ...context };
    for (const middleware of this.middlewares) {
      if (middleware.beforeModelCall) {
        ctx = await middleware.beforeModelCall(ctx);
      }
    }
    return ctx;
  }

  /** 执行 afterModelCall 链 */
  async executeAfterModelCall(context: MiddlewareContext, result: LLMResult): Promise<LLMResult> {
    let res = { ...result };
    for (const middleware of this.middlewares) {
      if (middleware.afterModelCall) {
        res = await middleware.afterModelCall(context, res);
      }
    }
    return res;
  }

  /** 执行 beforeToolCall 链 */
  async executeBeforeToolCall(context: ToolContext): Promise<ToolContext> {
    let ctx = { ...context };
    for (const middleware of this.middlewares) {
      if (middleware.beforeToolCall) {
        ctx = await middleware.beforeToolCall(ctx);
      }
    }
    return ctx;
  }

  /** 执行 afterToolCall 链 */
  async executeAfterToolCall(context: ToolContext, result: unknown): Promise<unknown> {
    let res = result;
    for (const middleware of this.middlewares) {
      if (middleware.afterToolCall) {
        res = await middleware.afterToolCall(context, res);
      }
    }
    return res;
  }

  /** 执行 onError 链 */
  async executeOnError(error: Error, context: MiddlewareContext): Promise<void> {
    for (const middleware of this.middlewares) {
      if (middleware.onError) {
        await middleware.onError(error, context);
      }
    }
  }

  /** 执行 onStreamEvent 链 */
  async executeOnStreamEvent(event: StreamEvent): Promise<StreamEvent | null> {
    let currentEvent: StreamEvent | null = { ...event };
    for (const middleware of this.middlewares) {
      if (middleware.onStreamEvent && currentEvent) {
        currentEvent = await middleware.onStreamEvent(currentEvent);
      }
    }
    return currentEvent;
  }

  /** 执行 wrapModelCall — 嵌套洋葱模型（有 wrap 的中间件优先，否则降级为 before/after） */
  async executeWrapModelCall(
    context: MiddlewareContext,
    core: () => Promise<LLMResult>,
  ): Promise<LLMResult> {
    const withWrap = this.middlewares.filter((m) => m.wrapModelCall);
    const withBeforeAfter = this.middlewares.filter((m) => !m.wrapModelCall && (m.beforeModelCall || m.afterModelCall));

    // 如果没有任何中间件有 wrap，降级为 before/after 模式
    if (withWrap.length === 0) {
      let ctx = context;
      for (const m of withBeforeAfter) {
        if (m.beforeModelCall) ctx = await m.beforeModelCall(ctx);
      }
      let result = await core();
      for (const m of withBeforeAfter) {
        if (m.afterModelCall) result = await m.afterModelCall(ctx, result);
      }
      return result;
    }

    // 嵌套执行 wrap 中间件（first → last 包裹）
    let fn = core;
    for (let i = withWrap.length - 1; i >= 0; i--) {
      const prev = fn;
      const mw = withWrap[i]!;
      fn = () => mw.wrapModelCall!(context, prev);
    }
    return fn();
  }

  /** 执行 wrapToolCall — 嵌套洋葱模型 */
  async executeWrapToolCall(
    context: ToolContext,
    core: () => Promise<unknown>,
  ): Promise<unknown> {
    const withWrap = this.middlewares.filter((m) => m.wrapToolCall);
    const withBeforeAfter = this.middlewares.filter((m) => !m.wrapToolCall && (m.beforeToolCall || m.afterToolCall));

    if (withWrap.length === 0) {
      let ctx = context;
      for (const m of withBeforeAfter) {
        if (m.beforeToolCall) ctx = await m.beforeToolCall(ctx);
      }
      let result = await core();
      for (const m of withBeforeAfter) {
        if (m.afterToolCall) result = await m.afterToolCall(ctx, result);
      }
      return result;
    }

    let fn = core;
    for (let i = withWrap.length - 1; i >= 0; i--) {
      const prev = fn;
      const mw = withWrap[i]!;
      fn = () => mw.wrapToolCall!(context, prev);
    }
    return fn();
  }
}

// ════════════════════════════════════════════════════════════
// 内置中间件
// ════════════════════════════════════════════════════════════

/** 日志中间件 */
export class LoggingMiddleware implements AgentMiddleware {
  name = 'logging';
  private logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };

  constructor(logger?: typeof this.logger) {
    this.logger = logger;
  }

  async beforeModelCall(context: MiddlewareContext): Promise<MiddlewareContext> {
    this.logger?.info(`[${this.name}] Before model call`, {
      sessionId: context.sessionId,
      messageCount: context.messages.length,
      toolCount: context.tools.length,
    });
    return context;
  }

  async afterModelCall(context: MiddlewareContext, result: LLMResult): Promise<LLMResult> {
    this.logger?.info(`[${this.name}] After model call`, {
      sessionId: context.sessionId,
      hasToolCalls: !!result.message.toolCalls?.length,
      usage: result.usage,
    });
    return result;
  }

  async beforeToolCall(context: ToolContext): Promise<ToolContext> {
    this.logger?.info(`[${this.name}] Before tool call`, {
      toolName: context.toolName,
      argsKeys: Object.keys(context.args),
    });
    return context;
  }

  async afterToolCall(context: ToolContext, result: unknown): Promise<unknown> {
    this.logger?.info(`[${this.name}] After tool call`, {
      toolName: context.toolName,
      resultType: typeof result,
    });
    return result;
  }

  async onError(error: Error, context: MiddlewareContext): Promise<void> {
    this.logger?.error(`[${this.name}] Error occurred`, {
      sessionId: context.sessionId,
      error: error.message,
    });
  }

  async onStreamEvent(event: StreamEvent): Promise<StreamEvent | null> {
    return event;
  }
}

/** 计时中间件 */
export class TimingMiddleware implements AgentMiddleware {
  name = 'timing';
  private timings = new Map<string, number>();

  async beforeModelCall(context: MiddlewareContext): Promise<MiddlewareContext> {
    this.timings.set(`model_${context.sessionId}`, Date.now());
    return context;
  }

  async afterModelCall(context: MiddlewareContext, result: LLMResult): Promise<LLMResult> {
    const key = `model_${context.sessionId}`;
    const startTime = this.timings.get(key);
    if (startTime) {
      const duration = Date.now() - startTime;
      this.timings.delete(key);
      // 记录到 metadata
      context.metadata.modelCallDuration = duration;
    }
    return result;
  }

  async beforeToolCall(context: ToolContext): Promise<ToolContext> {
    this.timings.set(`tool_${context.toolName}_${context.sessionId}`, Date.now());
    return context;
  }

  async afterToolCall(context: ToolContext, result: unknown): Promise<unknown> {
    const key = `tool_${context.toolName}_${context.sessionId}`;
    const startTime = this.timings.get(key);
    if (startTime) {
      const duration = Date.now() - startTime;
      this.timings.delete(key);
      context.metadata.toolCallDuration = duration;
    }
    return result;
  }
}


// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export function createMiddlewareChain(middlewares: AgentMiddleware[] = []): MiddlewareChain {
  return new MiddlewareChain(middlewares);
}

export function createLoggingMiddleware(logger?: ConstructorParameters<typeof LoggingMiddleware>[0]): LoggingMiddleware {
  return new LoggingMiddleware(logger);
}

export function createTimingMiddleware(): TimingMiddleware {
  return new TimingMiddleware();
}



