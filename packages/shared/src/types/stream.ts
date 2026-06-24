// SSE 流式事件类型定义

export type SSEEventType =
  | 'run_start'
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'error'
  | 'run_end';

export interface SSEEvent {
  type: SSEEventType;
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  traceId?: string;
  totalTokens?: number;
  modelUsed?: string;
  timestamp: number;
}
