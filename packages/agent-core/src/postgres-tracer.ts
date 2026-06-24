/**
 * PostgresTracer — 将 Agent 运行过程写入 agent_runs + agent_run_events 表
 *
 * 职责:
 * 1. startTrace() → 创建 agent_run 记录，返回 runId
 * 2. traceLLMCall() / traceToolCall() / traceError() → 写入 agent_run_events
 * 3. endTrace() → 更新 agent_runs 的 ended_at / status / total_tokens / duration_ms
 *
 * 批量写入优化:
 * - 内部维护 buffer: agent_run_events[]
 * - 每 500ms 或 buffer 达 20 条时 flush（批量 INSERT）
 * - endTrace 时强制 flush
 * - flush 失败降级为逐条 INSERT（fire-and-forget）
 */

import type { Pool } from '@zhonggui/data';
import crypto from 'node:crypto';
import type {
  Tracer,
  TraceSpan,
  ChatMessage,
  LLMResult,
} from './index.js';

// ════════════════════════════════════════════════════════════
// Buffer 事件类型
// ════════════════════════════════════════════════════════════

interface BufferedEvent {
  runId: string;
  eventType: string;
  eventData: Record<string, unknown>;
  durationMs: number | null;
}

// ════════════════════════════════════════════════════════════
// Run 状态追踪
// ════════════════════════════════════════════════════════════

interface RunState {
  runId: string;
  startedAt: number;
  totalTokens: number;
  toolCallCount: number;
}

// ════════════════════════════════════════════════════════════
// PostgresTracer
// ════════════════════════════════════════════════════════════

export class PostgresTracer implements Tracer {
  name = 'postgres';

  private pool: Pool;
  private buffer: BufferedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private runs = new Map<string, RunState>();

  // 配置常量
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_BATCH_SIZE = 20;

  constructor(pool: Pool) {
    this.pool = pool;
    // 启动定时 flush
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // 定时 flush 失败静默处理（降级在 flush 内部）
      });
    }, PostgresTracer.FLUSH_INTERVAL_MS);
  }

  /**
   * 销毁 tracer，停止定时器并 flush 剩余事件
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  // ─── Tracer 接口实现 ───

  /**
   * 创建 agent_run 记录，返回 runId（= traceId）
   */
  startTrace(
    name: string,
    attributes?: Record<string, unknown>,
  ): string {
    const runId = crypto.randomUUID();

    // 异步写入 DB（fire-and-forget，不阻塞调用方）
    const agentId = (attributes?.agentId as string) ?? '00000000-0000-0000-0000-000000000000';
    const sessionId = (attributes?.sessionId as string) ?? '';
    const userId = (attributes?.userId as string) ?? '';
    const modelUsed = (attributes?.modelUsed as string) ?? null;

    this.pool
      .query(
        `INSERT INTO agent_runs (id, agent_id, session_id, user_id, model_used, status, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', NOW())`,
        [runId, agentId, sessionId, userId, modelUsed],
      )
      .catch((err) => {
        console.error('[PostgresTracer] Failed to start trace:', err);
      });

    this.runs.set(runId, {
      runId,
      startedAt: Date.now(),
      totalTokens: 0,
      toolCallCount: 0,
    });

    return runId;
  }

  /**
   * 记录 Agent 运行（兼容 Tracer 接口，内部不额外操作）
   */
  traceAgentRun(
    traceId: string,
    _input: string,
    _attributes?: Record<string, unknown>,
  ): void {
    // Agent 运行信息已在 startTrace 中记录，此处可选追加事件
    this.enqueueEvent(traceId, 'agent_run', {
      input: _input?.slice(0, 500),
      ..._attributes,
    }, null);
  }

  /**
   * 记录 LLM 调用
   */
  traceLLMCall(
    traceId: string,
    model: string,
    _messages: ChatMessage[],
    result: LLMResult,
    durationMs: number,
  ): void {
    const run = this.runs.get(traceId);
    if (run && result.usage) {
      run.totalTokens += (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
    }

    this.enqueueEvent(traceId, 'llm_call', {
      model,
      messageCount: _messages?.length ?? 0,
      hasToolCalls: !!result.message.toolCalls?.length,
      usage: result.usage ?? null,
      contentLength: result.message.content?.length ?? 0,
    }, durationMs);
  }

  /**
   * 记录工具调用
   */
  traceToolCall(
    traceId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
  ): void {
    const run = this.runs.get(traceId);
    if (run) {
      run.toolCallCount += 1;
    }

    this.enqueueEvent(traceId, 'tool_call', {
      toolName,
      args: this.safeSerialize(args),
      resultType: typeof result,
      resultPreview: this.safePreview(result, 200),
    }, durationMs);
  }

  /**
   * 记录错误
   */
  traceError(
    traceId: string,
    error: Error,
    context?: Record<string, unknown>,
  ): void {
    this.enqueueEvent(traceId, 'error', {
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack?.slice(0, 1000),
      ...context,
    }, null);
  }

  /**
   * 记录自定义事件
   */
  traceEvent(
    traceId: string,
    name: string,
    attributes?: Record<string, unknown>,
  ): void {
    this.enqueueEvent(traceId, 'custom', {
      eventName: name,
      ...attributes,
    }, null);
  }

  /**
   * 结束追踪，更新 agent_runs 记录
   */
  endTrace(traceId: string): void {
    // 强制 flush 剩余事件
    this.flush().catch(() => {});

    const run = this.runs.get(traceId);
    if (!run) return;

    const durationMs = Date.now() - run.startedAt;

    // 异步更新 DB
    this.pool
      .query(
        `UPDATE agent_runs
         SET ended_at = NOW(),
             status = 'completed',
             total_tokens = $2,
             duration_ms = $3,
             tool_call_count = $4
         WHERE id = $1`,
        [traceId, run.totalTokens || null, durationMs, run.toolCallCount],
      )
      .catch((err) => {
        console.error('[PostgresTracer] Failed to end trace:', err);
      });

    this.runs.delete(traceId);
  }

  /**
   * 获取追踪数据（PostgresTracer 不支持内存查询，返回 undefined）
   * 真实数据请从 DB 查询
   */
  getTrace(_traceId: string): TraceSpan[] | undefined {
    return undefined;
  }

  // ─── 批量写入 ───

  /**
   * 将事件加入 buffer
   */
  private enqueueEvent(
    runId: string,
    eventType: string,
    eventData: Record<string, unknown>,
    durationMs: number | null,
  ): void {
    this.buffer.push({ runId, eventType, eventData, durationMs });

    if (this.buffer.length >= PostgresTracer.FLUSH_BATCH_SIZE) {
      this.flush().catch(() => {});
    }
  }

  /**
   * 批量 flush buffer 到 DB
   * 失败时降级为逐条 INSERT（fire-and-forget）
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = this.buffer.splice(0);
    const COLS = 4;

    try {
      // 构建批量 INSERT
      const values = events
        .map((_, i) => `($${i * COLS + 1}, $${i * COLS + 2}, $${i * COLS + 3}, $${i * COLS + 4})`)
        .join(', ');

      const params = events.flatMap((e) => [
        e.runId,
        e.eventType,
        JSON.stringify(e.eventData),
        e.durationMs,
      ]);

      await this.pool.query(
        `INSERT INTO agent_run_events (run_id, event_type, event_data, duration_ms) VALUES ${values}`,
        params,
      );
    } catch (batchErr) {
      console.error('[PostgresTracer] Batch insert failed, falling back to individual inserts:', batchErr);

      // 降级: 逐条 INSERT (fire-and-forget)
      for (const event of events) {
        this.pool
          .query(
            `INSERT INTO agent_run_events (run_id, event_type, event_data, duration_ms) VALUES ($1, $2, $3, $4)`,
            [event.runId, event.eventType, JSON.stringify(event.eventData), event.durationMs],
          )
          .catch((err) => {
            console.error('[PostgresTracer] Individual insert also failed:', err);
          });
      }
    }
  }

  // ─── 工具方法 ───

  private safeSerialize(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  private safePreview(value: unknown, maxLen: number): string | null {
    if (value === null || value === undefined) return null;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }
}

// ╀── 工厂函数 ───

export function createPostgresTracer(pool: Pool): PostgresTracer {
  return new PostgresTracer(pool);
}
