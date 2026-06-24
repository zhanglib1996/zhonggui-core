import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionManager } from '../session.js';
import type { ChatMessage } from '../index.js';

function mockPool(existingSession?: { id: string; user_id: string; title?: string }) {
  return {
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sessions')) return { rows: [] };
      if (sql.includes('INSERT INTO messages')) return { rows: [] };
      if (sql.includes('DELETE FROM sessions')) return { rows: [] };
      if (sql.includes('UPDATE sessions')) return { rows: [] };
      if (sql.includes('SELECT id, user_id, title, created_at, updated_at FROM sessions')) {
        if (existingSession) return { rows: [existingSession] };
        return { rows: [] };
      }
      if (sql.includes('SELECT user_id FROM sessions')) {
        return { rows: [{ user_id: existingSession?.user_id ?? 'user-1' }] };
      }
      if (sql.includes('SELECT') && sql.includes('FROM messages')) {
        return { rows: [] };
      }
      if (sql.includes('COUNT(m.id)')) {
        return { rows: [{ id: 's1', title: null, message_count: '0', created_at: new Date(), updated_at: new Date() }] };
      }
      return { rows: [] };
    }),
  };
}

function mockValkey(cached?: string | null) {
  const store = new Map<string, string>();
  if (cached !== undefined && cached !== null) {
    store.set('session:sess-1:ctx', cached);
  }
  return {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    set: vi.fn().mockImplementation(async (key: string, value: string) => { store.set(key, value); }),
    del: vi.fn().mockImplementation(async (key: string) => { store.delete(key); }),
  };
}

describe('createSessionManager', () => {
  it('should create a session and return id', async () => {
    const pool = mockPool();
    const valkey = mockValkey();
    const sm = createSessionManager(pool as any, valkey as any);

    const id = await sm.create('user-1');
    expect(id).toBeTruthy();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sessions'),
      expect.arrayContaining(['user-1']),
    );
    expect(valkey.set).toHaveBeenCalled();
  });

  it('should resume session from valkey cache', async () => {
    const cached = JSON.stringify({ userId: 'user-1', messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: new Date() }] });
    const pool = mockPool({ id: 'sess-1', user_id: 'user-1' });
    const valkey = mockValkey(cached);
    const sm = createSessionManager(pool as any, valkey as any);

    const session = await sm.resume('sess-1');
    expect(session).not.toBeNull();
    expect(session!.id).toBe('sess-1');
    expect(session!.userId).toBe('user-1');
    expect(session!.messages).toHaveLength(1);
  });

  it('should return null for non-existent session', async () => {
    const pool = mockPool(); // no existing session
    const valkey = mockValkey();
    const sm = createSessionManager(pool as any, valkey as any);

    const session = await sm.resume('nonexistent');
    expect(session).toBeNull();
  });

  it('should destroy session', async () => {
    const pool = mockPool();
    const valkey = mockValkey();
    const sm = createSessionManager(pool as any, valkey as any);

    await sm.destroy('sess-1');
    expect(pool.query).toHaveBeenCalledWith('DELETE FROM sessions WHERE id = $1', ['sess-1']);
    expect(valkey.del).toHaveBeenCalledWith('session:sess-1:ctx');
  });

  it('should add message and update cache', async () => {
    const cached = JSON.stringify({ userId: 'user-1', messages: [] });
    const pool = mockPool({ id: 'sess-1', user_id: 'user-1' });
    const valkey = mockValkey(cached);
    const sm = createSessionManager(pool as any, valkey as any);

    const msg: ChatMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      timestamp: new Date(),
    };

    await sm.addMessage('sess-1', msg);

    // 验证 PG 插入
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO messages'),
      expect.arrayContaining(['msg-1', 'sess-1']),
    );

    // 验证 Valkey 缓存更新
    expect(valkey.set).toHaveBeenCalled();
  });

  it('should get messages from PG', async () => {
    const pool = mockPool();
    const valkey = mockValkey();
    const sm = createSessionManager(pool as any, valkey as any);

    const messages = await sm.getMessages('sess-1');
    expect(Array.isArray(messages)).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM messages'),
      ['sess-1'],
    );
  });
});
