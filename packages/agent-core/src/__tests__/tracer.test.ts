import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsoleTracer, TracerManager } from '../tracer.js';
import type { ChatMessage, LLMResult } from '../index.js';

describe('ConsoleTracer', () => {
  let tracer: ConsoleTracer;

  beforeEach(() => {
    tracer = new ConsoleTracer();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should start and end a trace', () => {
    const traceId = tracer.startTrace('test');
    expect(traceId).toBeTruthy();
    expect(traceId).toMatch(/^trace_/);

    tracer.endTrace(traceId);
    const spans = tracer.getTrace(traceId);
    expect(spans).toBeDefined();
    expect(spans![0].endTime).toBeDefined();
  });

  it('should record agent run span', () => {
    const traceId = tracer.startTrace('test');
    tracer.traceAgentRun(traceId, 'hello world');
    const spans = tracer.getTrace(traceId);
    expect(spans!.length).toBe(2); // root + agent_run
    expect(spans![1].name).toBe('agent_run');
    expect(spans![1].attributes.input).toBe('hello world');
  });

  it('should record LLM call span', () => {
    const traceId = tracer.startTrace('test');
    const messages: ChatMessage[] = [{ id: 'm1', role: 'user', content: 'hi', timestamp: new Date() }];
    const result: LLMResult = {
      message: { id: 'm2', role: 'assistant', content: 'hello', timestamp: new Date() },
      usage: { inputTokens: 100, outputTokens: 50 },
    };

    tracer.traceLLMCall(traceId, 'gpt-4', messages, result, 500);
    const spans = tracer.getTrace(traceId);
    expect(spans!.length).toBe(2);
    expect(spans![1].name).toBe('llm_call');
    expect(spans![1].attributes.model).toBe('gpt-4');
    expect(spans![1].attributes.durationMs).toBe(500);
  });

  it('should record tool call span', () => {
    const traceId = tracer.startTrace('test');
    tracer.traceToolCall(traceId, 'run_python', { code: 'print(1)' }, { stdout: '1' }, 100);
    const spans = tracer.getTrace(traceId);
    expect(spans![1].name).toBe('tool_call');
    expect(spans![1].attributes.toolName).toBe('run_python');
  });

  it('should record error span', () => {
    const traceId = tracer.startTrace('test');
    tracer.traceError(traceId, new Error('test error'), { context: 'test' });
    const spans = tracer.getTrace(traceId);
    expect(spans![1].name).toBe('error');
    expect(spans![1].attributes.errorMessage).toBe('test error');
  });

  it('should record custom events', () => {
    const traceId = tracer.startTrace('test');
    tracer.traceEvent(traceId, 'custom_event', { key: 'value' });
    const spans = tracer.getTrace(traceId);
    expect(spans![0].events).toHaveLength(1);
    expect(spans![0].events[0].name).toBe('custom_event');
  });

  it('should clear all traces', () => {
    tracer.startTrace('test1');
    tracer.startTrace('test2');
    tracer.clearTraces();
    expect(tracer.getAllTraces().size).toBe(0);
  });
});

describe('TracerManager', () => {
  it('should fan out to multiple tracers', () => {
    const manager = new TracerManager([]);
    const mockTracer = new ConsoleTracer();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    manager.add(mockTracer);
    const traceId = manager.startTrace('test');
    expect(traceId).toBeTruthy();
  });
});
