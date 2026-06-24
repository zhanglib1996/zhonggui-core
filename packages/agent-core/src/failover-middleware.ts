/**
 * LLM 故障转移中间件 — 参考 NexAU 的 LLMFailoverMiddleware 设计
 *
 * 功能：
 * - 多 provider 降级链
 * - 熔断器（open / half-open / closed）
 * - 可重试错误识别
 * - 自动恢复检测
 */

import type { AgentMiddleware } from './index.js';
import type { MiddlewareContext, LLMResult } from './middleware.js';

// ════════════════════════════════════════════════════════════
// 熔断器
// ════════════════════════════════════════════════════════════

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerOptions {
  /** 连续失败多少次后打开熔断器，默认 5 */
  failureThreshold?: number;
  /** 熔断器打开后多久尝试半开（ms），默认 30000 */
  cooldownMs?: number;
  /** 半开状态允许的试探请求失败次数，默认 1 */
  halfOpenMaxFailures?: number;
}

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenFailures = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxFailures: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.halfOpenMaxFailures = options.halfOpenMaxFailures ?? 1;
  }

  getState(): CircuitState {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.cooldownMs) {
      this.state = 'half-open';
      this.halfOpenFailures = 0;
    }
    return this.state;
  }

  canExecute(): boolean {
    const state = this.getState();
    return state === 'closed' || state === 'half-open';
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenFailures = 0;
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();
    if (this.state === 'half-open') {
      this.halfOpenFailures++;
      if (this.halfOpenFailures >= this.halfOpenMaxFailures) {
        this.state = 'open';
      }
      return;
    }
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.halfOpenFailures = 0;
    this.lastFailureTime = 0;
  }
}

// ════════════════════════════════════════════════════════════
// 错误分类
// ════════════════════════════════════════════════════════════

/** 判断是否为可重试的网络/服务器错误 */
function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // HTTP 5xx / 429
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('529')) return true;
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  // 网络错误
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('etimedout')) return true;
  if (msg.includes('fetch failed') || msg.includes('network')) return true;
  return false;
}

// ════════════════════════════════════════════════════════════
// Failover 中间件
// ════════════════════════════════════════════════════════════

export interface FailoverProvider {
  name: string;
  /** 修改 context 中的 metadata，让 runtime 的 callLLM 使用此 provider 的配置 */
  applyToContext: (context: MiddlewareContext) => MiddlewareContext;
}

export interface LLMFailoverMiddlewareOptions {
  /** 降级 provider 列表（按优先级排序） */
  providers: FailoverProvider[];
  /** 熔断器配置 */
  circuitBreaker?: CircuitBreakerOptions;
  /** 自定义可重试错误判断 */
  isRetryable?: (error: Error) => boolean;
  /** 失败回调 */
  onFailover?: (from: string, to: string, error: Error) => void;
}

export class LLMFailoverMiddleware implements AgentMiddleware {
  name = 'llm-failover';
  private providers: FailoverProvider[];
  private breakers: Map<string, CircuitBreaker> = new Map();
  private checkRetryable: (error: Error) => boolean;
  private onFailover?: (from: string, to: string, error: Error) => void;

  constructor(options: LLMFailoverMiddlewareOptions) {
    this.providers = options.providers;
    this.checkRetryable = options.isRetryable ?? isRetryableError;
    this.onFailover = options.onFailover;
    for (const provider of this.providers) {
      this.breakers.set(provider.name, new CircuitBreaker(options.circuitBreaker));
    }
  }

  async wrapModelCall(
    context: MiddlewareContext,
    next: () => Promise<LLMResult>,
  ): Promise<LLMResult> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      const breaker = this.getBreaker(provider.name);

      if (!breaker.canExecute()) {
        continue; // 跳过熔断的 provider
      }

      try {
        // 修改 context 使用此 provider
        const providerContext = provider.applyToContext(context);
        // 替换原始 context 的 metadata
        Object.assign(context.metadata, providerContext.metadata);

        const result = await next();
        breaker.recordSuccess();
        return result;
      } catch (err) {
        const error = err as Error;
        lastError = error;
        breaker.recordFailure();

        if (!this.checkRetryable(error)) {
          throw error; // 不可重试的错误直接抛出
        }

        // 寻找下一个可用 provider
        const nextProvider = this.findNextProvider(provider.name);
        if (nextProvider) {
          this.onFailover?.(provider.name, nextProvider.name, error);
        }
      }
    }

    // 所有 provider 都失败
    throw lastError ?? new Error('All LLM providers failed');
  }

  private getBreaker(name: string): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  private findNextProvider(currentName: string): FailoverProvider | undefined {
    const idx = this.providers.findIndex((p) => p.name === currentName);
    for (let i = idx + 1; i < this.providers.length; i++) {
      const breaker = this.getBreaker(this.providers[i]!.name);
      if (breaker.canExecute()) return this.providers[i];
    }
    return undefined;
  }

  /** 获取所有 provider 的熔断器状态 */
  getStates(): Record<string, CircuitState> {
    const states: Record<string, CircuitState> = {};
    for (const provider of this.providers) {
      states[provider.name] = this.getBreaker(provider.name).getState();
    }
    return states;
  }

  /** 重置所有熔断器 */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /** 重置指定 provider 的熔断器 */
  reset(providerName: string): void {
    this.breakers.get(providerName)?.reset();
  }
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export function createLLMFailoverMiddleware(options: LLMFailoverMiddlewareOptions): LLMFailoverMiddleware {
  return new LLMFailoverMiddleware(options);
}
