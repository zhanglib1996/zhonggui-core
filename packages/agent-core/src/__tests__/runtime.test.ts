import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createAgentRuntime } from '../runtime.js';
import type {
  AgentOptions,
  AgentRuntime,
  AgentTool,
  ChatMessage,
  Session,
  SessionManager,
  ToolRegistry,
  SandboxProvider,
  MemoryHook,
  ModelRouter,
  Logger,
  StreamEvent,
} from '../index.js';

// ─── Mock 工厂 ───

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    userId: 'user-1',
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockSessionManager(session: Session | null = createMockSession()): SessionManager {
  return {
    create: vi.fn().mockResolvedValue('sess-1'),
    resume: vi.fn().mockResolvedValue(session),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue(session?.messages ?? []),
  };
}

function createMockToolRegistry(tools: AgentTool[] = []): ToolRegistry {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  return {
    register: vi.fn((tool: AgentTool) => toolMap.set(tool.name, tool)),
    get: vi.fn((name: string) => toolMap.get(name)),
    list: vi.fn(() => [...toolMap.values()]),
  };
}

function createMockSandbox(): SandboxProvider {
  return {
    runPython: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 10, timedOut: false, oom: false }),
    runShell: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 10, timedOut: false, oom: false }),
    runNode: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 10, timedOut: false, oom: false }),
  };
}

function createMockMemoryHook(): MemoryHook {
  return {
    onMessage: vi.fn().mockResolvedValue(undefined),
    onSessionEnd: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue([]),
  };
}

function createMockModelRouter(): ModelRouter {
  return {
    selectModel: vi.fn().mockReturnValue({
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost:9999/v1',
    }),
    degrade: vi.fn().mockReturnValue({
      provider: 'test',
      model: 'fallback-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost:9999/v1',
    }),
  };
}

function createMockLogger(): Logger {
  return {
    operation: vi.fn(),
    token: vi.fn(),
    error: vi.fn(),
    audit: vi.fn(),
  };
}

function createBaseOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    baseModel: {
      provider: 'test',
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost:9999/v1',
    },
    sessionManager: createMockSessionManager(),
    toolRegistry: createMockToolRegistry(),
    sandbox: createMockSandbox(),
    ...overrides,
  };
}

// ─── Mock fetch ───

function mockFetchLLMResponse(content: string, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
  const mockResponse = {
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { role: 'assistant', content, tool_calls: toolCalls?.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    text: vi.fn().mockResolvedValue(''),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
  return mockResponse;
}

function mockFetchError(status: number, errorText: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, text: vi.fn().mockResolvedValue(errorText), json: vi.fn() }));
}

// ─── 辅助 ───

async function collectEvents(runtime: AgentRuntime, message: string = 'hello'): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of runtime.chat('sess-1' as any, 'user-1' as any, message)) {
    events.push(event);
  }
  return events;
}

// ════════════════════════════════════════════════════════════

describe('createAgentRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should create runtime with required options', () => {
    const runtime = createAgentRuntime(createBaseOptions());
    expect(runtime).toBeDefined();
    expect(runtime.chat).toBeTypeOf('function');
    expect(runtime.getAvailableTools).toBeTypeOf('function');
  });

  it('should register 3 builtin tools', () => {
    const registry = createMockToolRegistry();
    createAgentRuntime(createBaseOptions({ toolRegistry: registry }));
    expect(registry.register).toHaveBeenCalledTimes(3);
    const names = (registry.register as Mock).mock.calls.map((c: any) => c[0].name);
    expect(names).toContain('run_python');
    expect(names).toContain('run_shell');
    expect(names).toContain('run_node');
  });

  it('should yield text and done events for simple response', async () => {
    mockFetchLLMResponse('Hello!');
    const runtime = createAgentRuntime(createBaseOptions());
    const events = await collectEvents(runtime);
    // run_start → text → run_end → done
    expect(events[0].type).toBe('run_start');
    const textEvent = events.find((e) => e.type === 'text');
    expect(textEvent!.content).toBe('Hello!');
    const done = events.find((e) => e.type === 'done');
    expect(done!.modelUsed).toBe('test-model');
    expect(events.some((e) => e.type === 'run_end')).toBe(true);
  });

  it('should report token usage in done event', async () => {
    mockFetchLLMResponse('Response');
    const events = await collectEvents(createAgentRuntime(createBaseOptions()));
    const done = events.find((e) => e.type === 'done');
    expect(done!.totalTokens).toBe(150);
  });

  it('should execute tool calls and yield tool_call + tool_result', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'run_python', arguments: JSON.stringify({ code: 'print(1)' }) } }] } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), text: async () => '' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 80, completion_tokens: 10 } }), text: async () => '' };
    }));

    const sandbox = createMockSandbox();
    const events = await collectEvents(createAgentRuntime(createBaseOptions({ sandbox })));
    expect(events.filter((e) => e.type === 'tool_call').length).toBe(1);
    expect(events.filter((e) => e.type === 'tool_result').length).toBe(1);
    expect(sandbox.runPython).toHaveBeenCalledWith('print(1)');
  });

  it('should handle multiple tool calls in one round', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'run_python', arguments: JSON.stringify({ code: '1' }) } },
          { id: 'tc-2', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo' }) } },
        ] } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), text: async () => '' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 80, completion_tokens: 10 } }), text: async () => '' };
    }));

    const events = await collectEvents(createAgentRuntime(createBaseOptions()));
    expect(events.filter((e) => e.type === 'tool_call').length).toBe(2);
  });

  it('should execute tools in parallel by default', async () => {
    const executionOrder: string[] = [];
    const slowTool: AgentTool = {
      name: 'slow',
      description: '',
      parameters: {},
      execute: async () => { await new Promise((r) => setTimeout(r, 50)); executionOrder.push('slow'); return 'slow'; },
    };
    const fastTool: AgentTool = {
      name: 'fast',
      description: '',
      parameters: {},
      execute: async () => { executionOrder.push('fast'); return 'fast'; },
    };

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'slow', arguments: '{}' } },
          { id: 'tc-2', type: 'function', function: { name: 'fast', arguments: '{}' } },
        ] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
    }));

    const registry = createMockToolRegistry();
    registry.get = vi.fn((name: string) => name === 'slow' ? slowTool : name === 'fast' ? fastTool : undefined);
    registry.list = vi.fn(() => [slowTool, fastTool]);

    await collectEvents(createAgentRuntime(createBaseOptions({ toolRegistry: registry })));
    // 并行执行时 fast 先于 slow 完成
    expect(executionOrder).toEqual(['fast', 'slow']);
  });

  it('should execute tools sequentially when maxToolConcurrency=1', async () => {
    const executionOrder: string[] = [];
    const slowTool: AgentTool = {
      name: 'slow',
      description: '',
      parameters: {},
      execute: async () => { await new Promise((r) => setTimeout(r, 50)); executionOrder.push('slow'); return 'slow'; },
    };
    const fastTool: AgentTool = {
      name: 'fast',
      description: '',
      parameters: {},
      execute: async () => { executionOrder.push('fast'); return 'fast'; },
    };

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'slow', arguments: '{}' } },
          { id: 'tc-2', type: 'function', function: { name: 'fast', arguments: '{}' } },
        ] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
    }));

    const registry = createMockToolRegistry();
    registry.get = vi.fn((name: string) => name === 'slow' ? slowTool : name === 'fast' ? fastTool : undefined);
    registry.list = vi.fn(() => [slowTool, fastTool]);

    await collectEvents(createAgentRuntime(createBaseOptions({ toolRegistry: registry, maxToolConcurrency: 1 })));
    // 串行执行时 slow 先于 fast（因为 slow 在前）
    expect(executionOrder).toEqual(['slow', 'fast']);
  });

  it('should yield error when session not found', async () => {
    const events = await collectEvents(createAgentRuntime(createBaseOptions({ sessionManager: createMockSessionManager(null) })));
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('not found');
  });

  it('should yield error on LLM API failure', async () => {
    mockFetchError(500, 'Internal Server Error');
    const events = await collectEvents(createAgentRuntime(createBaseOptions()));
    expect(events.find((e) => e.type === 'error')).toBeDefined();
  });

  it('should try model degradation on LLM failure', async () => {
    const modelRouter = createMockModelRouter();
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 500, text: async () => 'fail' };
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Recovered' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
    }));

    const events = await collectEvents(createAgentRuntime(createBaseOptions({ modelRouter })));
    expect(modelRouter.degrade).toHaveBeenCalledWith('test-model');
    expect(events.find((e) => e.type === 'text' && e.content === 'Recovered')).toBeDefined();
  });

  it('should respect maxConversationTurns', async () => {
    const session = createMockSession({
      messages: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, role: (i % 2 === 0 ? 'user' : 'assistant') as const, content: `msg${i}`, timestamp: new Date() })),
    });
    const events = await collectEvents(createAgentRuntime(createBaseOptions({ sessionManager: createMockSessionManager(session), maxConversationTurns: 5 })));
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('turn limit');
  });

  it('should respect maxToolCalls limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'run_python', arguments: JSON.stringify({ code: '1' }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '',
    }));

    const events = await collectEvents(createAgentRuntime(createBaseOptions({ maxToolCalls: 3 })));
    expect(events.filter((e) => e.type === 'tool_call').length).toBe(3);
    expect(events.find((e) => e.type === 'error')!.message).toContain('limit');
  });

  it('should return error for unknown tool without mcpServer', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'unknown', arguments: '{}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
    }));

    const registry = createMockToolRegistry([]);
    registry.get = vi.fn().mockReturnValue(undefined);
    const events = await collectEvents(createAgentRuntime(createBaseOptions({ toolRegistry: registry })));
    expect(events.find((e) => e.type === 'tool_result')!.result).toEqual({ error: 'Tool "unknown" not found' });
  });

  it('should call memoryHook.onMessage and recall', async () => {
    mockFetchLLMResponse('Response');
    const memoryHook = createMockMemoryHook();
    await collectEvents(createAgentRuntime(createBaseOptions({ memoryHook })));
    expect(memoryHook.onMessage).toHaveBeenCalled();
    expect(memoryHook.recall).toHaveBeenCalledWith('sess-1', 'user-1', 'hello', 5);
  });

  it('should inject memory context into user message', async () => {
    const memoryHook = createMockMemoryHook();
    (memoryHook.recall as Mock).mockResolvedValue([{ id: 'm1', content: '用户喜欢 Python', similarity: 0.9 }]);
    mockFetchLLMResponse('Response');
    await collectEvents(createAgentRuntime(createBaseOptions({ memoryHook })));
    const body = JSON.parse((global.fetch as Mock).mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toContain('[相关记忆]');
    expect(userMsg.content).toContain('用户喜欢 Python');
  });

  it('should call logger.token after LLM call', async () => {
    mockFetchLLMResponse('Response');
    const logger = createMockLogger();
    await collectEvents(createAgentRuntime(createBaseOptions({ logger })));
    expect(logger.token).toHaveBeenCalledWith('user-1', 'test-model', 100, 50);
  });

  it('should support registerMiddleware at runtime', async () => {
    mockFetchLLMResponse('Response');
    const runtime = createAgentRuntime(createBaseOptions());
    let called = false;
    runtime.registerMiddleware({ name: 'test', async beforeModelCall(ctx) { called = true; return ctx; } });
    await collectEvents(runtime);
    expect(called).toBe(true);
  });

  it('should use mcpServer.callTool for MCP tools', async () => {
    const mcpServer = { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn().mockResolvedValue({ result: 'from mcp' }) };
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'mcp_tool', arguments: '{"x":1}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
      return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), text: async () => '' };
    }));
    const registry = createMockToolRegistry([]);
    registry.get = vi.fn().mockReturnValue(undefined);
    const events = await collectEvents(createAgentRuntime(createBaseOptions({ toolRegistry: registry, mcpServer })));
    expect(mcpServer.callTool).toHaveBeenCalledWith('mcp_tool', { x: 1 });
    expect(events.find((e) => e.type === 'tool_result')!.result).toEqual({ result: 'from mcp' });
  });

  it('should return all tools from registry + skill + mcp', async () => {
    const runtime = createAgentRuntime(createBaseOptions({
      skillLoader: { load: vi.fn().mockResolvedValue([{ name: 'sk', description: '', parameters: {}, execute: vi.fn() }]), loadByName: vi.fn() },
      mcpServer: { listTools: vi.fn().mockResolvedValue([{ name: 'mcp', description: '', parameters: {}, execute: vi.fn() }]), callTool: vi.fn() },
    }));
    const tools = await runtime.getAvailableTools('sess-1' as any, 'user-1' as any);
    const names = tools.map((t) => t.name);
    expect(names).toContain('run_python');
    expect(names).toContain('sk');
    expect(names).toContain('mcp');
  });
});
