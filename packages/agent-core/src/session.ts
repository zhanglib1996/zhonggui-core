/**
 * SessionManager 实现
 * 基于 PostgreSQL 的会话生命周期管理
 */

import { nanoid } from 'nanoid';
import type { Pool, ValkeyClient } from '@zhonggui/data';
import type { SessionManager, Session, SessionSummary, ChatMessage } from './index.js';

// P1-1: LRU 缓存限制 — 最多 500 个会话缓存条目
const MAX_CACHE_SIZE = 500;
const sessionCacheKeys = new Map<string, number>(); // key → access timestamp

function evictOldestCache(): void {
  const oldest = sessionCacheKeys.keys().next().value;
  if (oldest) {
    sessionCacheKeys.delete(oldest);
    // 注意：Valkey 条目有 TTL 24h，此处不主动 del，仅移除本地跟踪
  }
}

export function createSessionManager(pool: Pool, valkey: ValkeyClient): SessionManager {
  return {
    async create(userId) {
      const id = nanoid();
      await pool.query(
        `INSERT INTO sessions (id, user_id, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())`,
        [id, userId],
      );

      // P1-1: LRU 缓存限制 — 在 set 前检查并驱逐
      const cacheKey = `session:${id}:ctx`;
      if (sessionCacheKeys.size >= MAX_CACHE_SIZE) {
        evictOldestCache();
      }
      // 在 Valkey 中创建会话上下文缓存
      await valkey.set(cacheKey, JSON.stringify({ userId, messages: [] }), 86400);
      sessionCacheKeys.set(cacheKey, Date.now());

      return id;
    },

    async resume(sessionId) {
      // 先从 Valkey 缓存读取
      const cached = await valkey.get(`session:${sessionId}:ctx`);
      if (cached) {
        // P1-1: 更新 LRU 访问时间
        sessionCacheKeys.set(`session:${sessionId}:ctx`, Date.now());
        const ctx = JSON.parse(cached) as { userId: string; messages: ChatMessage[] };
        const { rows } = await pool.query(
          'SELECT id, user_id, title, created_at, updated_at FROM sessions WHERE id = $1',
          [sessionId],
        );
        if (rows.length === 0) return null;
        const row = rows[0]!;
        return {
          id: row.id,
          userId: row.user_id,
          title: row.title,
          messages: ctx.messages,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      // 缓存未命中，从 PG 读取
      const { rows } = await pool.query(
        'SELECT id, user_id, title, created_at, updated_at FROM sessions WHERE id = $1',
        [sessionId],
      );
      if (rows.length === 0) return null;

      const row = rows[0]!;
      const messages = await this.getMessages(sessionId);

      // P1-1: LRU 缓存限制 — 回填缓存前检查
      if (sessionCacheKeys.size >= MAX_CACHE_SIZE) {
        evictOldestCache();
      }
      // 回填缓存
      await valkey.set(
        `session:${sessionId}:ctx`,
        JSON.stringify({ userId: row.user_id, messages }),
        86400,
      );
      sessionCacheKeys.set(`session:${sessionId}:ctx`, Date.now());

      return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        messages,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    async destroy(sessionId) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      await valkey.del(`session:${sessionId}:ctx`);
      sessionCacheKeys.delete(`session:${sessionId}:ctx`); // P1-1: 清理 LRU 跟踪
    },

    async list(userId, limit = 50, offset = 0) {
      const { rows } = await pool.query(
        `SELECT s.id, s.title, s.created_at, s.updated_at,
                COUNT(m.id) as message_count
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.user_id = $1
         GROUP BY s.id
         ORDER BY s.updated_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        messageCount: Number(row.message_count),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    async addMessage(sessionId, message, userId?: string) {
      // P1-2: 从参数或缓存获取 userId（避免 N+1 查询）
      let uid = userId ?? '';
      const cacheKey = `session:${sessionId}:ctx`;
      const cached = await valkey.get(cacheKey);
      if (cached) {
        const ctx = JSON.parse(cached) as { userId: string; messages: ChatMessage[] };
        if (!uid) uid = ctx.userId;

        // 更新 Valkey 缓存（复用已读取的 cached 数据）
        ctx.messages.push(message);
        await valkey.set(cacheKey, JSON.stringify(ctx), 86400);
      } else if (!uid) {
        // 缓存未命中，回退到 PG 查询
        uid = (await pool.query('SELECT user_id FROM sessions WHERE id = $1', [sessionId])).rows[0]?.user_id ?? '';
      }

      // 持久化到 PG
      await pool.query(
        `INSERT INTO messages (id, session_id, user_id, role, content, tool_calls, tool_call_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          message.id,
          sessionId,
          uid,
          message.role,
          message.content,
          message.toolCalls ? JSON.stringify(message.toolCalls) : null,
          message.toolCallId ?? null,
          message.timestamp,
        ],
      );

      // 缓存更新已在上方 consolidated 块中处理（P1-2 优化）

      // 更新 session 的 updated_at
      await pool.query(
        'UPDATE sessions SET updated_at = NOW() WHERE id = $1',
        [sessionId],
      );
    },

    async getMessages(sessionId) {
      const { rows } = await pool.query(
        `SELECT id, role, content, tool_calls, tool_call_id, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [sessionId],
      );

      return rows.map((row) => ({
        id: row.id,
        role: row.role as ChatMessage['role'],
        content: row.content,
        toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
        toolCallId: row.tool_call_id ?? undefined,
        timestamp: row.created_at,
      }));
    },
  };
}
