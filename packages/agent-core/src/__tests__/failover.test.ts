import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMFailoverMiddleware } from '../failover-middleware.js';
import type { MiddlewareContext, LLMResult } from '../index.js';
import type { FailoverProvider } from '../failover-middleware.js';

function createContext(metadata: Record<string, unknown> = {}): MiddlewareContext {
  return {
    sessionId: 'test',
    userId: 'user1',
    messages: [],
    tools: [],
    metadata: { ...metadata },
  };
}

function createResult(content = 'ok'): LLMResult {
  return {
    message: { id: '1', role: 'assistant', content, timestamp: new Date() },
  };
}

describe('LLMFailoverMiddleware', () => {
  it('should call next directly when only one provider succeeds', async () => {
    const provider: FailoverProvider = {
      name: 'primary',
      applyToContext: (ctx) => ctx,
    };
    const mw = new LLMFailoverMiddleware({ providers: [provider] });
    const result = await mw.wrapModelCall(createContext(), async () => createResult('primary'));
    expect(result.message.content).toBe('primary');
  });

  it('should fallback to second provider when first fails with retryable error', async () => {
    const primary: FailoverProvider = {
      name: 'primary',
      applyToContext: (ctx) => ctx,
    };
    const fallback: FailoverProvider = {
      name: 'fallback',
      applyToContext: (ctx) => {
        ctx.metadata.provider = 'fallback';
        return ctx;
      },
    };

    let callCount = 0;
    const mw = new LLMFailoverMiddleware({ providers: [primary, fallback] });
    const result = await mw.wrapModelCall(createContext(), async () => {
      callCount++;
      if (callCount === 1) throw new Error('LLM API error 500: Internal Server Error');
      return createResult('fallback');
    });

    expect(result.message.content).toBe('fallback');
    expect(callCount).toBe(2);
  });

  it('should throw immediately for non-retryable errors', async () => {
    const provider: FailoverProvider = {
      name: 'primary',
      applyToContext: (ctx) => ctx,
    };
    const mw = new LLMFailoverMiddleware({ providers: [provider] });

    await expect(
      mw.wrapModelCall(createContext(), async () => {
        throw new Error('Invalid API key');
      }),
    ).rejects.toThrow('Invalid API key');
  });

  it('should call onFailover callback', async () => {
    const onFailover = vi.fn();
    const primary: FailoverProvider = { name: 'primary', applyToContext: (ctx) => ctx };
    const fallback: FailoverProvider = { name: 'fallback', applyToContext: (ctx) => ctx };

    const mw = new LLMFailoverMiddleware({
      providers: [primary, fallback],
      onFailover,
    });

    let callCount = 0;
    await mw.wrapModelCall(createContext(), async () => {
      callCount++;
      if (callCount === 1) throw new Error('503 Service Unavailable');
      return createResult();
    });

    expect(onFailover).toHaveBeenCalledWith('primary', 'fallback', expect.any(Error));
  });

  it('should trip circuit breaker after threshold failures', async () => {
    const provider: FailoverProvider = { name: 'primary', applyToContext: (ctx) => ctx };
    const fallback: FailoverProvider = { name: 'fallback', applyToContext: (ctx) => ctx };

    const mw = new LLMFailoverMiddleware({
      providers: [provider, fallback],
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    // 触发 2 次失败使 primary 熔断
    // 使用自定义 isRetryable 让 fallback 不记录失败（只 primary 失败）
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapModelCall(createContext(), async () => {
          throw new Error('500 error');
        });
      } catch { /* expected */ }
    }

    // 验证 primary 已熔断
    expect(mw.getStates()['primary']).toBe('open');

    // 重置 fallback 的熔断器（因为上面的循环也让 fallback 失败了）
    mw.reset('fallback');

    // 下次调用 primary 被跳过，直接走 fallback
    const result = await mw.wrapModelCall(createContext(), async () => {
      return createResult('fallback');
    });

    expect(result.message.content).toBe('fallback');
  });

  it('should reset circuit breaker', () => {
    const provider: FailoverProvider = { name: 'primary', applyToContext: (ctx) => ctx };
    const mw = new LLMFailoverMiddleware({
      providers: [provider],
      circuitBreaker: { failureThreshold: 1 },
    });

    // 触发熔断
    mw.wrapModelCall(createContext(), async () => {
      throw new Error('500');
    }).catch(() => {});

    setTimeout(() => {
      mw.reset('primary');
      expect(mw.getStates()['primary']).toBe('closed');
    }, 10);
  });

  it('should use custom isRetryable function', async () => {
    const provider: FailoverProvider = { name: 'primary', applyToContext: (ctx) => ctx };
    const fallback: FailoverProvider = { name: 'fallback', applyToContext: (ctx) => ctx };

    const mw = new LLMFailoverMiddleware({
      providers: [provider, fallback],
      isRetryable: (err) => err.message.includes('CUSTOM_RETRY'),
    });

    let callCount = 0;
    const result = await mw.wrapModelCall(createContext(), async () => {
      callCount++;
      if (callCount === 1) throw new Error('CUSTOM_RETRY please');
      return createResult('recovered');
    });

    expect(result.message.content).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('should throw when all providers fail', async () => {
    const p1: FailoverProvider = { name: 'p1', applyToContext: (ctx) => ctx };
    const p2: FailoverProvider = { name: 'p2', applyToContext: (ctx) => ctx };

    const mw = new LLMFailoverMiddleware({ providers: [p1, p2] });

    await expect(
      mw.wrapModelCall(createContext(), async () => {
        throw new Error('500 Server Error');
      }),
    ).rejects.toThrow('500 Server Error');
  });

  it('should reset all circuit breakers', () => {
    const p1: FailoverProvider = { name: 'p1', applyToContext: (ctx) => ctx };
    const p2: FailoverProvider = { name: 'p2', applyToContext: (ctx) => ctx };
    const mw = new LLMFailoverMiddleware({ providers: [p1, p2], circuitBreaker: { failureThreshold: 1 } });

    // 触发两个 provider 熔断
    mw.wrapModelCall(createContext(), async () => { throw new Error('500'); }).catch(() => {});
    mw.wrapModelCall(createContext(), async () => { throw new Error('500'); }).catch(() => {});

    setTimeout(() => {
      mw.resetAll();
      expect(mw.getStates()['p1']).toBe('closed');
      expect(mw.getStates()['p2']).toBe('closed');
    }, 10);
  });
});
