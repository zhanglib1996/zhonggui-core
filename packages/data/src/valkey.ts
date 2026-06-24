/**
 * Valkey 客户端（BSD-3, Redis 100% API 兼容）
 * 用于会话缓存 / L0 热记忆 / 限流计数器
 */

import Redis from 'ioredis';

// ─── 配置 ───

export interface ValkeyConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

// ─── 客户端接口 ───

export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  /** 关闭连接 */
  disconnect(): Promise<void>;
  // ─── SORTED SET（滑动窗口限流器使用）───
  zadd(key: string, score: number, member: string): Promise<void>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<any[]>;
}

// ─── 创建客户端 ───

export function createValkey(config: ValkeyConfig): ValkeyClient {
  const redis = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db ?? 0,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
    },
  });

  // 订阅用独立连接
  let subClient: Redis | null = null;
  function getSubClient(): Redis {
    if (!subClient) {
      subClient = redis.duplicate();
    }
    return subClient;
  }

  return {
    async get(key) {
      return redis.get(key);
    },

    async set(key, value, ttlSeconds) {
      if (ttlSeconds) {
        await redis.set(key, value, 'EX', ttlSeconds);
      } else {
        await redis.set(key, value);
      }
    },

    async del(key) {
      await redis.del(key);
    },

    async hgetall(key) {
      return redis.hgetall(key);
    },

    async hset(key, field, value) {
      await redis.hset(key, field, value);
    },

    async incr(key) {
      return redis.incr(key);
    },

    async expire(key, seconds) {
      await redis.expire(key, seconds);
    },

    async publish(channel, message) {
      await redis.publish(channel, message);
    },

    async subscribe(channel, handler) {
      const sub = getSubClient();
      await sub.subscribe(channel);
      sub.on('message', (ch, msg) => {
        if (ch === channel) handler(msg);
      });
    },

    async disconnect() {
      subClient?.disconnect();
      redis.disconnect();
    },

    // ─── SORTED SET ───
    async zadd(key, score, member) {
      await redis.zadd(key, score, member);
    },
    async zremrangebyscore(key, min, max) {
      return redis.zremrangebyscore(key, min, max);
    },
    async zcard(key) {
      return redis.zcard(key);
    },
    async zrange(key, start, stop) {
      return redis.zrange(key, start, stop);
    },
    async eval(script, numKeys, ...args) {
      return redis.eval(script, numKeys, ...args) as Promise<any[]>;
    },
  };
}

// ─── 滑动窗口限流器（基于 Valkey SORTED SET）───

export interface RateLimiter {
  check(key: string): Promise<{ allowed: boolean; remaining: number; resetMs: number }>;
}

/**
 * 创建滑动窗口限流器
 *
 * 实现原理：通过 Valkey Lua 脚本原子化执行滑动窗口限流：
 *   1. ZADD 将当前请求时间戳加入 SORTED SET
 *   2. ZREMRANGEBYSCORE 删除窗口外的旧记录
 *   3. ZCARD 获取窗口内请求计数
 *   4. EXPIRE 设置 key TTL 防泄漏
 *   5. 检查是否允许并返回 remaining / resetMs
 *
 * 所有操作在一次 eval 调用中原子完成。
 *
 * @param client Valkey 客户端
 * @param max 窗口内最大请求数
 * @param windowMs 窗口大小（毫秒）
 */
export function createRateLimiter(client: ValkeyClient, max: number, windowMs: number): RateLimiter {
  const windowSeconds = windowMs / 1000;

  // Lua 脚本：原子化滑动窗口限流
  const SCRIPT = `
    local zset_key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window_start = now - tonumber(ARGV[2])
    local member = ARGV[3]
    local max_requests = tonumber(ARGV[4])
    local window_seconds = tonumber(ARGV[5])

    redis.call('ZADD', zset_key, now, member)
    redis.call('ZREMRANGEBYSCORE', zset_key, 0, window_start)
    local count = redis.call('ZCARD', zset_key)
    redis.call('EXPIRE', zset_key, window_seconds + 1)

    local allowed = count <= max_requests
    local remaining = math.max(0, max_requests - count)

    -- 取最早记录计算 reset 时间
    local first = redis.call('ZRANGE', zset_key, 0, 0, 'WITHSCORES')
    local reset_ms = window_seconds * 1000
    if #first >= 2 then
      local first_score = tonumber(first[2])
      reset_ms = math.max(0, math.ceil(first_score + tonumber(ARGV[2]) - now))
    end

    return {allowed and 1 or 0, remaining, reset_ms}
  `;

  return {
    async check(key) {
      const now = Date.now();
      const zsetKey = `limiter:${key}`;
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

      const result = await client.eval(SCRIPT, 1, zsetKey, now, windowMs, member, max, windowSeconds);

      const _allowed = result[0] === 1;
      const _remaining = Number(result[1]);
      const _resetMs = Number(result[2]);

      return { allowed: _allowed, remaining: _remaining, resetMs: _resetMs };
    },
  };
}
