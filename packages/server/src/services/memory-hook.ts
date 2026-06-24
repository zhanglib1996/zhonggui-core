/**
 * MemoryHook 实现
 * 内存存储 + JSON 文件持久化
 *
 * 接口来自 @zhonggui/agent-core:
 *   onMessage(sessionId, userId, message)
 *   recall(sessionId, userId, query, topK?)
 *   onSessionEnd(sessionId, userId)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryHook, ChatMessage, MemoryEntry } from '@zhonggui/agent-core';
import type { SessionId, UserId } from '@zhonggui/data';

// ─── 内存条目 ───

interface StoredMemory {
  id: string;
  sessionId: string;
  userId: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: string;
}

// ─── 简单文本相似度（关键词重叠） ───

function simpleSimilarity(query: string, text: string): number {
  const queryTokens = tokenize(query);
  const textTokens = tokenize(text);
  if (queryTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) overlap++;
  }
  return overlap / queryTokens.size;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

// ─── 工厂函数 ───

export interface MemoryHookOptions {
  /** JSON 持久化文件目录，默认 ~/.zhonggui/memory */
  dataDir?: string;
}

export function createMemoryHook(options?: MemoryHookOptions): MemoryHook {
  const dataDir = options?.dataDir ?? join(process.env.HOME ?? '/tmp', '.zhonggui', 'memory');
  const store = new Map<string, StoredMemory[]>(); // sessionId → memories[]
  const filePath = join(dataDir, 'memories.json');

  // 启动时从文件加载
  let loaded = false;
  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      if (existsSync(filePath)) {
        const raw = await readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, StoredMemory[]>;
        for (const [sid, memories] of Object.entries(data)) {
          store.set(sid, memories);
        }
        console.log(`[MemoryHook] Loaded ${store.size} session memories from ${filePath}`);
      }
    } catch (err) {
      console.warn('[MemoryHook] Failed to load memories file:', err);
    }
  }

  async function persist(): Promise<void> {
    try {
      await mkdir(dataDir, { recursive: true });
      const data: Record<string, StoredMemory[]> = {};
      for (const [sid, memories] of store) {
        data[sid] = memories;
      }
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[MemoryHook] Failed to persist memories:', err);
    }
  }

  return {
    async onMessage(sessionId: SessionId, userId: UserId, message: ChatMessage): Promise<void> {
      await ensureLoaded();

      const sid = sessionId as string;
      const uid = userId as string;

      if (!store.has(sid)) {
        store.set(sid, []);
      }

      const memories = store.get(sid)!;
      memories.push({
        id: message.id,
        sessionId: sid,
        userId: uid,
        content: message.content,
        role: message.role as 'user' | 'assistant',
        timestamp: message.timestamp.toISOString(),
      });

      // 限制每个会话最多 500 条记忆
      if (memories.length > 500) {
        memories.splice(0, memories.length - 500);
      }

      // 异步持久化（不阻塞调用方）
      void persist();
    },

    async recall(
      sessionId: SessionId,
      userId: UserId,
      query: string,
      topK: number = 5,
    ): Promise<MemoryEntry[]> {
      await ensureLoaded();

      const sid = sessionId as string;
      const uid = userId as string;
      const memories = store.get(sid) ?? [];

      // 在当前会话历史中搜索
      const results: MemoryEntry[] = [];

      for (const mem of memories) {
        // 只返回同用户的记忆
        if (mem.userId !== uid) continue;

        const similarity = simpleSimilarity(query, mem.content);
        if (similarity > 0.1) {
          results.push({
            id: mem.id,
            content: mem.content,
            similarity,
            metadata: { role: mem.role, sessionId: mem.sessionId },
            source: 'l0',
          });
        }
      }

      // 也搜索其他会话的记忆（跨会话召回）
      for (const [otherSid, otherMemories] of store) {
        if (otherSid === sid) continue;
        for (const mem of otherMemories) {
          if (mem.userId !== uid) continue;
          const similarity = simpleSimilarity(query, mem.content);
          if (similarity > 0.2) {
            results.push({
              id: mem.id,
              content: mem.content,
              similarity: similarity * 0.8, // 跨会话降权
              metadata: { role: mem.role, sessionId: mem.sessionId },
              source: 'l1',
            });
          }
        }
      }

      // 按相似度排序，取 topK
      results.sort((a, b) => b.similarity - a.similarity);
      return results.slice(0, topK);
    },

    async onSessionEnd(sessionId: SessionId, userId: UserId): Promise<void> {
      await ensureLoaded();

      const sid = sessionId as string;
      // 会话结束时持久化一次
      await persist();
      console.log(`[MemoryHook] Session ${sid} ended, memories persisted.`);
    },
  };
}
