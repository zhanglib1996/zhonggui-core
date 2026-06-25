/**
 * 会话 CRUD 路由
 * GET    /sessions       — 获取会话列表
 * POST   /sessions       — 创建新会话
 * GET    /sessions/:id   — 获取会话详情
 * DELETE /sessions/:id   — 删除会话
 */

import { Router, type Request, type Response } from 'express';
import type { SessionManager } from '@zhonggui/agent-core';

export function createSessionsRouter(getSessionManager: () => SessionManager): Router {
  const router = Router();

  /**
   * GET /sessions
   * Query: userId (required), limit (optional, default 50), offset (optional, default 0)
   */
  router.get('/sessions', async (req: Request, res: Response) => {
    const userId = req.query.userId as string;
    if (!userId) {
      res.status(400).json({ error: 'Missing required query param: userId' });
      return;
    }

    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    try {
      const sm = getSessionManager();
      const sessions = await sm.list(userId, limit, offset);
      res.json({ sessions });
    } catch (err) {
      console.error('[Sessions] list error:', err);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  /**
   * POST /sessions
   * Body: { userId: string }
   */
  router.post('/sessions', async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'Missing required field: userId' });
      return;
    }

    try {
      const sm = getSessionManager();
      const sessionId = await sm.create(userId);
      res.status(201).json({ id: sessionId, sessionId, userId });
    } catch (err) {
      console.error('[Sessions] create error:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  /**
   * GET /sessions/:id
   * 返回会话详情（含消息历史）
   */
  router.get('/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string;

    try {
      const sm = getSessionManager();
      const session = await sm.resume(id);
      if (!session) {
        res.status(404).json({ error: `Session ${id} not found` });
        return;
      }
      res.json(session);
    } catch (err) {
      console.error('[Sessions] get error:', err);
      res.status(500).json({ error: 'Failed to get session' });
    }
  });

  /**
   * DELETE /sessions/:id
   */
  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params.id as string;

    try {
      const sm = getSessionManager();
      await sm.destroy(id);
      res.status(204).end();
    } catch (err) {
      console.error('[Sessions] delete error:', err);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  return router;
}
