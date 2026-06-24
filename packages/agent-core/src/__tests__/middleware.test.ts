import { describe, it, expect, vi } from 'vitest';
import {
  MiddlewareChain,
  LoggingMiddleware,
  TimingMiddleware,
} from '../middleware.js';
import type { MiddlewareContext, ToolContext, LLMResult, StreamEvent } from '../index.js';

describe('MiddlewareChain', () => {
  it('should execute beforeModelCall in order', async () => {
    const order: number[] = [];
    const chain = new MiddlewareChain([
      {
        name: 'first',
        async beforeModelCall(ctx) {
          order.push(1);
          return ctx;
        },
      },
      {
        name: 'second',
        async beforeModelCall(ctx) {
          order.push(2);
          return ctx;
        },
      },
    ]);

    const context: MiddlewareContext = {
      sessionId: 'test',
      userId: 'user1',
      messages: [],
      tools: [],
      metadata: {},
    };

    await chain.executeBeforeModelCall(context);
    expect(order).toEqual([1, 2]);
  });

  it('should execute afterModelCall in order', async () => {
    const order: number[] = [];
    const chain = new MiddlewareChain([
      {
        name: 'first',
        async afterModelCall(ctx, result) {
          order.push(1);
          return result;
        },
      },
      {
        name: 'second',
        async afterModelCall(ctx, result) {
          order.push(2);
          return result;
        },
      },
    ]);

    const context: MiddlewareContext = {
      sessionId: 'test',
      userId: 'user1',
      messages: [],
      tools: [],
      metadata: {},
    };

    const result: LLMResult = {
      message: {
        id: '1',
        role: 'assistant',
        content: 'test',
        timestamp: new Date(),
      },
    };

    await chain.executeAfterModelCall(context, result);
    expect(order).toEqual([1, 2]);
  });

  it('should add and remove middleware', () => {
    const chain = new MiddlewareChain();
    chain.use({ name: 'test', async beforeModelCall(ctx) { return ctx; } });
    expect(chain.list()).toHaveLength(1);

    chain.remove('test');
    expect(chain.list()).toHaveLength(0);
  });
});


describe('MiddlewareChain wrap hooks', () => {
  const context: MiddlewareContext = {
    sessionId: 'test',
    userId: 'user1',
    messages: [],
    tools: [],
    metadata: {},
  };

  const mockResult: LLMResult = {
    message: { id: '1', role: 'assistant', content: 'test', timestamp: new Date() },
  };

  it('should execute wrapModelCall in nested order', async () => {
    const order: string[] = [];
    const chain = new MiddlewareChain([
      {
        name: 'outer',
        async wrapModelCall(ctx, next) {
          order.push('outer-before');
          const result = await next();
          order.push('outer-after');
          return result;
        },
      },
      {
        name: 'inner',
        async wrapModelCall(ctx, next) {
          order.push('inner-before');
          const result = await next();
          order.push('inner-after');
          return result;
        },
      },
    ]);

    await chain.executeWrapModelCall(context, async () => {
      order.push('core');
      return mockResult;
    });

    expect(order).toEqual(['outer-before', 'inner-before', 'core', 'inner-after', 'outer-after']);
  });

  it('should execute wrapToolCall in nested order', async () => {
    const order: string[] = [];
    const toolCtx: ToolContext = { sessionId: 'test', userId: 'user1', toolName: 'test', args: {}, metadata: {} };

    const chain = new MiddlewareChain([
      {
        name: 'outer',
        async wrapToolCall(ctx, next) {
          order.push('outer');
          return next();
        },
      },
      {
        name: 'inner',
        async wrapToolCall(ctx, next) {
          order.push('inner');
          return next();
        },
      },
    ]);

    await chain.executeWrapToolCall(toolCtx, async () => {
      order.push('core');
      return 'ok';
    });

    expect(order).toEqual(['outer', 'inner', 'core']);
  });

  it('should fallback to before/after when no wrap hooks exist', async () => {
    const order: string[] = [];
    const chain = new MiddlewareChain([
      {
        name: 'legacy',
        async beforeModelCall(ctx) { order.push('before'); return ctx; },
        async afterModelCall(ctx, result) { order.push('after'); return result; },
      },
    ]);

    await chain.executeWrapModelCall(context, async () => {
      order.push('core');
      return mockResult;
    });

    expect(order).toEqual(['before', 'core', 'after']);
  });

  it('should allow wrap to modify context before core', async () => {
    const chain = new MiddlewareChain([
      {
        name: 'injector',
        async wrapModelCall(ctx, next) {
          ctx.metadata.injected = true;
          return next();
        },
      },
    ]);

    let capturedCtx: MiddlewareContext | undefined;
    await chain.executeWrapModelCall(context, async (ctx) => {
      capturedCtx = context;
      return mockResult;
    });

    expect(context.metadata.injected).toBe(true);
  });

  it('should allow wrap to short-circuit (skip core)', async () => {
    const chain = new MiddlewareChain([
      {
        name: 'blocker',
        async wrapModelCall(ctx, next) {
          return mockResult; // 不调用 next()
        },
      },
    ]);

    let coreCalled = false;
    await chain.executeWrapModelCall(context, async () => {
      coreCalled = true;
      return mockResult;
    });

    expect(coreCalled).toBe(false);
  });

  it('should allow wrap to catch errors from core', async () => {
    let caughtError: Error | undefined;
    const chain = new MiddlewareChain([
      {
        name: 'catcher',
        async wrapModelCall(ctx, next) {
          try {
            return await next();
          } catch (err) {
            caughtError = err as Error;
            return mockResult;
          }
        },
      },
    ]);

    const result = await chain.executeWrapModelCall(context, async () => {
      throw new Error('LLM failed');
    });

    expect(caughtError?.message).toBe('LLM failed');
    expect(result).toBe(mockResult);
  });
});
