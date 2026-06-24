/**
 * 追踪系统 — 参考 NexAU 的 Tracer 设计
 *
 * 支持分布式追踪和可观测性：
 * - ConsoleTracer: 控制台输出（开发环境）
 * - 多追踪器支持
 */

import type { ChatMessage } from './index.js';
import type { LLMResult } from './middleware.js';

// ════════════════════════════════════════════════════════════
// 追踪器接口
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

  /** 开始新的追踪 */
  startTrace(name: string, attributes?: Record<string, unknown>): string;

  /** 结束追踪 */
  endTrace(traceId: string): void;

  /** 记录 Agent 运行 */
  traceAgentRun(traceId: string, input: string, attributes?: Record<string, unknown>): void;

  /** 记录 LLM 调用 */
  traceLLMCall(
    traceId: string,
    model: string,
    messages: ChatMessage[],
    result: LLMResult,
    durationMs: number,
  ): void;

  /** 记录工具调用 */
  traceToolCall(
    traceId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
  ): void;

  /** 记录错误 */
  traceError(traceId: string, error: Error, context?: Record<string, unknown>): void;

  /** 记录自定义事件 */
  traceEvent(traceId: string, name: string, attributes?: Record<string, unknown>): void;

  /** 获取追踪数据 */
  getTrace(traceId: string): TraceSpan[] | undefined;
}

// ════════════════════════════════════════════════════════════
// 控制台追踪器（开发环境）
// ════════════════════════════════════════════════════════════

export class ConsoleTracer implements Tracer {
  name = 'console';
  private traces = new Map<string, TraceSpan[]>();
  private currentSpanId = 0;

  startTrace(name: string, attributes: Record<string, unknown> = {}): string {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const span: TraceSpan = {
      traceId,
      spanId: `span_${this.currentSpanId++}`,
      name,
      startTime: Date.now(),
      attributes,
      events: [],
    };
    this.traces.set(traceId, [span]);
    console.log(`[Tracer] Started trace: ${traceId} - ${name}`);
    return traceId;
  }

  endTrace(traceId: string): void {
    const spans = this.traces.get(traceId);
    if (spans) {
      const rootSpan = spans[0];
      if (rootSpan) {
        rootSpan.endTime = Date.now();
        const duration = rootSpan.endTime - rootSpan.startTime;
        console.log(`[Tracer] Ended trace: ${traceId} - Duration: ${duration}ms`);
      }
    }
  }

  traceAgentRun(traceId: string, input: string, attributes: Record<string, unknown> = {}): void {
    const span = this.createSpan(traceId, 'agent_run', {
      input,
      ...attributes,
    });
    console.log(`[Tracer] Agent run: ${input.slice(0, 50)}...`);
  }

  traceLLMCall(
    traceId: string,
    model: string,
    messages: ChatMessage[],
    result: LLMResult,
    durationMs: number,
  ): void {
    const span = this.createSpan(traceId, 'llm_call', {
      model,
      messageCount: messages.length,
      hasToolCalls: !!result.message.toolCalls?.length,
      usage: result.usage,
      durationMs,
    });
    console.log(`[Tracer] LLM call: ${model} - ${durationMs}ms`);
    if (result.usage) {
      console.log(`[Tracer] Token usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
    }
  }

  traceToolCall(
    traceId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
  ): void {
    const span = this.createSpan(traceId, 'tool_call', {
      toolName,
      args,
      resultType: typeof result,
      durationMs,
    });
    console.log(`[Tracer] Tool call: ${toolName} - ${durationMs}ms`);
  }

  traceError(traceId: string, error: Error, context: Record<string, unknown> = {}): void {
    const span = this.createSpan(traceId, 'error', {
      errorMessage: error.message,
      errorStack: error.stack,
      ...context,
    });
    console.error(`[Tracer] Error: ${error.message}`);
  }

  traceEvent(traceId: string, name: string, attributes: Record<string, unknown> = {}): void {
    const spans = this.traces.get(traceId);
    if (spans && spans.length > 0) {
      const currentSpan = spans[spans.length - 1];
      if (currentSpan) {
        currentSpan.events.push({
          name,
          timestamp: Date.now(),
          attributes,
        });
      }
    }
    console.log(`[Tracer] Event: ${name}`);
  }

  getTrace(traceId: string): TraceSpan[] | undefined {
    return this.traces.get(traceId);
  }

  /** 获取所有追踪 */
  getAllTraces(): Map<string, TraceSpan[]> {
    return new Map(this.traces);
  }

  /** 清除追踪数据 */
  clearTraces(): void {
    this.traces.clear();
  }

  private createSpan(traceId: string, name: string, attributes: Record<string, unknown> = {}): TraceSpan {
    const spans = this.traces.get(traceId);
    const parentSpanId = spans && spans.length > 0 ? spans[spans.length - 1]?.spanId : undefined;

    const span: TraceSpan = {
      traceId,
      spanId: `span_${this.currentSpanId++}`,
      parentSpanId,
      name,
      startTime: Date.now(),
      attributes,
      events: [],
    };

    if (spans) {
      spans.push(span);
    }

    return span;
  }
}


// ════════════════════════════════════════════════════════════
// 多追踪器管理
// ════════════════════════════════════════════════════════════

export class TracerManager implements Tracer {
  name = 'manager';
  private tracers: Tracer[] = [];

  constructor(tracers: Tracer[] = []) {
    this.tracers = [...tracers];
  }

  add(tracer: Tracer): void {
    this.tracers.push(tracer);
  }

  remove(name: string): void {
    this.tracers = this.tracers.filter((t) => t.name !== name);
  }

  startTrace(name: string, attributes?: Record<string, unknown>): string {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    for (const tracer of this.tracers) {
      try {
        tracer.startTrace(name, attributes);
      } catch (error) {
        console.error(`[TracerManager] Error starting trace in ${tracer.name}:`, error);
      }
    }
    return traceId;
  }

  endTrace(traceId: string): void {
    for (const tracer of this.tracers) {
      try {
        tracer.endTrace(traceId);
      } catch (error) {
        console.error(`[TracerManager] Error ending trace in ${tracer.name}:`, error);
      }
    }
  }

  traceAgentRun(traceId: string, input: string, attributes?: Record<string, unknown>): void {
    for (const tracer of this.tracers) {
      try {
        tracer.traceAgentRun(traceId, input, attributes);
      } catch (error) {
        console.error(`[TracerManager] Error in ${tracer.name}:`, error);
      }
    }
  }

  traceLLMCall(
    traceId: string,
    model: string,
    messages: ChatMessage[],
    result: LLMResult,
    durationMs: number,
  ): void {
    for (const tracer of this.tracers) {
      try {
        tracer.traceLLMCall(traceId, model, messages, result, durationMs);
      } catch (error) {
        console.error(`[TracerManager] Error in ${tracer.name}:`, error);
      }
    }
  }

  traceToolCall(
    traceId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
  ): void {
    for (const tracer of this.tracers) {
      try {
        tracer.traceToolCall(traceId, toolName, args, result, durationMs);
      } catch (error) {
        console.error(`[TracerManager] Error in ${tracer.name}:`, error);
      }
    }
  }

  traceError(traceId: string, error: Error, context?: Record<string, unknown>): void {
    for (const tracer of this.tracers) {
      try {
        tracer.traceError(traceId, error, context);
      } catch (error) {
        console.error(`[TracerManager] Error in ${tracer.name}:`, error);
      }
    }
  }

  traceEvent(traceId: string, name: string, attributes?: Record<string, unknown>): void {
    for (const tracer of this.tracers) {
      try {
        tracer.traceEvent(traceId, name, attributes);
      } catch (error) {
        console.error(`[TracerManager] Error in ${tracer.name}:`, error);
      }
    }
  }

  getTrace(traceId: string): TraceSpan[] | undefined {
    // 返回第一个追踪器的数据
    for (const tracer of this.tracers) {
      const trace = tracer.getTrace(traceId);
      if (trace) return trace;
    }
    return undefined;
  }
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export function createConsoleTracer(): ConsoleTracer {
  return new ConsoleTracer();
}



export function createTracerManager(tracers: Tracer[] = []): TracerManager {
  return new TracerManager(tracers);
}
