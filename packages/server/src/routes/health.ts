/**
 * 健康检查路由 — GET /health
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from '@zhonggui/data';

export function createHealthRouter(getPool?: () => Pool | null): Router {
  const router = Router();
  const startTime = Date.now();

  /**
   * GET /health
   * 返回服务状态、运行时间、PG 连接状态
   */
  router.get('/health', async (_req: Request, res: Response) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    let pgStatus = 'not_configured';
    let pgError: string | undefined;

    const pool = getPool?.();
    if (pool) {
      try {
        const result = await pool.query('SELECT 1 AS ok');
        pgStatus = result.rows[0]?.ok === 1 ? 'connected' : 'error';
      } catch (err) {
        pgStatus = 'error';
        pgError = err instanceof Error ? err.message : 'Unknown DB error';
      }
    }

    const healthy = pgStatus !== 'error';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      version: '0.1.0',
      uptime: uptimeSeconds,
      timestamp: new Date().toISOString(),
      checks: {
        postgres: { status: pgStatus, error: pgError },
      },
    });
  });

  return router;
}
