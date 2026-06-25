/**
 * @zhonggui/server — HTTP 服务入口
 *
 * Express 服务，集成:
 *   - AgentRuntime (agent-core)
 *   - PostgreSQL + Valkey (data)
 *   - SSE 流式对话
 *   - 会话管理 CRUD
 *   - 健康检查
 *   - JWT 认证（DEV_AUTH_BYPASS 开发模式可跳过）
 *
 * 环境变量:
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   VALKEY_HOST, VALKEY_PORT
 *   MODEL_API_KEY, MODEL_BASE_URL, MODEL_NAME, MODEL_PROVIDER
 *   JWT_SECRET, REFRESH_SECRET
 *   DEV_AUTH_BYPASS, ADMIN_USERS
 *   PORT (默认 3000)
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { createPool, createValkey, migrate } from '@zhonggui/data';
import type { Pool } from '@zhonggui/data';
import {
  createAgentRuntime,
  createSessionManager,
  createToolRegistry,
  createAgentFactory,
} from '@zhonggui/agent-core';
import type { AgentRuntime, SessionManager, SandboxProvider } from '@zhonggui/agent-core';

import { createChatRouter } from './routes/chat.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createHealthRouter } from './routes/health.js';
import { createMemoryHook } from './services/memory-hook.js';
import { createModelRouter } from './services/model-router.js';
import { createSkillLoader } from './services/skill-loader.js';

// ESM __dirname 模拟
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = join(__dirname, '../public');

// ─── 配置 ───

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS === 'true';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me';
const ADMIN_USERS = (process.env.ADMIN_USERS ?? '').split(',').filter(Boolean);

// ─── 认证中间件 ───

interface JwtPayload {
  sub: string;
  username?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

function createAuthMiddleware(getPool: () => any) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    // 开发模式跳过认证
    if (DEV_AUTH_BYPASS) {
      const userId = (req.headers['x-user-id'] as string) ?? req.query.userId ?? 'dev-user';
      (req as any).userId = typeof userId === 'string' ? userId : 'dev-user';
      (req as any).userRole = 'admin';

      // 确保 dev-user 存在于数据库中
      const pool = getPool();
      if (pool && userId === 'dev-user') {
        try {
          await pool.query(
            `INSERT INTO users (id, username, display_name, role)
             VALUES ('dev-user', 'dev-user', '开发用户', 'admin')
             ON CONFLICT (id) DO NOTHING`
          );
        } catch (err) {
          // 忽略错误
        }
      }

      next();
      return;
    }

    // JWT 认证
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
      (req as any).userId = payload.sub;
      (req as any).userRole = payload.role ?? 'user';
      next();
    } catch (err) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// ─── 本地沙箱实现（开发/测试用） ───

import { execSync } from 'node:child_process';

function createStubSandbox(): SandboxProvider {
  return {
    async runPython(code) {
      const start = Date.now();
      try {
        const stdout = execSync(`python3 -c ${JSON.stringify(code)}`, {
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
        return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - start, timedOut: false, oom: false };
      } catch (err: any) {
        return {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message,
          exitCode: err.status || 1,
          durationMs: Date.now() - start,
          timedOut: false,
          oom: false,
        };
      }
    },
    async runShell(cmd) {
      const start = Date.now();
      try {
        const stdout = execSync(cmd, {
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
        return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - start, timedOut: false, oom: false };
      } catch (err: any) {
        return {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message,
          exitCode: err.status || 1,
          durationMs: Date.now() - start,
          timedOut: false,
          oom: false,
        };
      }
    },
    async runNode(code) {
      const start = Date.now();
      try {
        const stdout = execSync(`node -e ${JSON.stringify(code)}`, {
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
        return { stdout, stderr: '', exitCode: 0, durationMs: Date.now() - start, timedOut: false, oom: false };
      } catch (err: any) {
        return {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message,
          exitCode: err.status || 1,
          durationMs: Date.now() - start,
          timedOut: false,
          oom: false,
        };
      }
    },
  };
}

// ─── 启动函数 ───

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     @zhonggui/server  v0.1.0        ║');
  console.log('╚══════════════════════════════════════╝');

  // ─── 1. 初始化数据层 ───

  let pool: Pool | null = null;
  let sessionManager: SessionManager | null = null;

  const pgHost = process.env.PG_HOST;
  if (pgHost) {
    try {
      pool = createPool({
        host: pgHost,
        port: parseInt(process.env.PG_PORT ?? '5432', 10),
        database: process.env.PG_DATABASE ?? 'zhonggui',
        user: process.env.PG_USER ?? 'postgres',
        password: process.env.PG_PASSWORD ?? '',
      });
      console.log(`[DB] PostgreSQL connected: ${pgHost}:${process.env.PG_PORT ?? 5432}`);

      // 执行迁移
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const migrationsDir = resolve(__dirname, '../../data/src/migrations');
      try {
        await migrate(pool, migrationsDir);
        console.log('[DB] Migrations applied');
      } catch (err) {
        console.warn('[DB] Migration skipped or failed:', err instanceof Error ? err.message : err);
      }

      // 创建 SessionManager
      const valkey = createValkey({
        host: process.env.VALKEY_HOST ?? 'localhost',
        port: parseInt(process.env.VALKEY_PORT ?? '6379', 10),
      });

      sessionManager = createSessionManager(pool, valkey);
      console.log('[DB] SessionManager initialized');
    } catch (err) {
      console.error('[DB] Failed to connect to PostgreSQL:', err);
      console.log('[DB] Running in degraded mode (no persistence)');
    }
  } else {
    console.log('[DB] PG_HOST not set, running without database');
  }

  // ─── 2. 初始化服务层 ───

  const memoryHook = createMemoryHook();
  const modelRouter = createModelRouter();
  const skillLoader = createSkillLoader();

  // ─── 3. 初始化 AgentRuntime ───

  let runtime: AgentRuntime | null = null;

  if (sessionManager) {
    const baseModel = modelRouter.selectModel('', '');
    const toolRegistry = createToolRegistry();
    const sandbox = createStubSandbox();

    runtime = createAgentRuntime({
      baseModel,
      sessionManager,
      toolRegistry,
      sandbox,
      memoryHook,
      skillLoader,
      modelRouter,
      systemPrompt: process.env.SYSTEM_PROMPT ?? undefined,
    });

    console.log('[Agent] Runtime initialized');
  } else {
    console.log('[Agent] Skipped (no database connection)');
  }

  // ─── 4. 创建 Express 应用 ───

  const app = express();

  // 安全 & 中间件
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  // 静态文件服务 (在 API 路由之前)
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    console.log(`[Static] Serving static files from: ${publicDir}`);
  }

  // 请求日志
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const start = Date.now();
    _res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/health') {
        console.log(`[HTTP] ${req.method} ${req.path} → ${_res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });

  // ─── 5. 注册路由 ───

  // 健康检查（无需认证）
  app.use(createHealthRouter(() => pool));

  // ─── 认证路由（无需认证） ───

  // POST /auth/login - 登录
  app.post('/auth/login', async (req: Request, res: Response) => {
    const { username } = req.body;

    if (!username) {
      res.status(400).json({ error: 'Username required' });
      return;
    }

    // DEV_AUTH_BYPASS 模式: 直接返回成功
    if (DEV_AUTH_BYPASS) {
      // 查询用户
      let userId = 'dev-user';
      if (pool) {
        try {
          const { rows } = await pool.query(
            'SELECT id, username, role FROM users WHERE username = $1',
            [username]
          );
          if (rows.length > 0) {
            userId = rows[0].id;
          }
        } catch (err) {
          // 忽略错误，使用默认用户
        }
      }

      res.json({
        user: {
          id: userId,
          username: username,
          roles: ['admin']
        },
        tokens: {
          accessToken: 'cookie-based'
        }
      });
      return;
    }

    // 非 DEV_AUTH_BYPASS 模式: 验证密码（暂时返回 401）
    res.status(401).json({ error: 'Invalid credentials' });
  });

  // POST /auth/logout - 登出
  app.post('/auth/logout', (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  // 认证中间件（/health 和 /auth 之后的所有路由需要认证）
  app.use(createAuthMiddleware(() => pool));

  // GET /auth/me - 获取当前用户信息（需要认证）
  app.get('/auth/me', (req: Request, res: Response) => {
    const userId = (req as any).userId || 'dev-user';
    const userRole = (req as any).userRole || 'admin';
    res.json({
      id: userId,
      username: userId,
      roles: [userRole]
    });
  });

  // ─── API 路由别名（兼容前端调用） ───

  // GET /api/agents - 获取 Agent 列表
  app.get('/api/agents', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM agents WHERE is_active = true');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch agents:', err);
      res.status(500).json({ error: 'Failed to fetch agents' });
    }
  });

  // POST /api/agents/:id/sessions - 创建会话
  app.post('/api/agents/:id/sessions', async (req: Request, res: Response) => {
    const { id: agentId } = req.params;
    const { title } = req.body;
    const userId = req.body.userId || (req as any).userId || '00000000-0000-0000-0000-000000000001';

    if (!sessionManager) {
      res.status(503).json({ error: 'Session manager not initialized' });
      return;
    }
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    try {
      const sessionId = await sessionManager.create(userId);
      if (title) {
        await pool.query('UPDATE sessions SET title = $1, agent_id = $2 WHERE id = $1', [title, sessionId]);
      }
      // 同时更新 agent_id
      await pool.query('UPDATE sessions SET agent_id = $1 WHERE id = $2', [agentId, sessionId]);
      res.json({ id: sessionId, sessionId, agentId });
    } catch (err) {
      console.error('[API] Failed to create session:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // POST /api/agents/:id/chat - SSE 流式对话
  app.post('/api/agents/:id/chat', async (req: Request, res: Response) => {
    const { sessionId, message } = req.body;
    const userId = req.body.userId || (req as any).userId || '00000000-0000-0000-0000-000000000001';

    if (!runtime) {
      res.status(503).json({ error: 'Agent runtime not initialized' });
      return;
    }

    // 设置 SSE 头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      const stream = runtime.chat(sessionId, message, userId);
      for await (const event of stream) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err: any) {
      console.error('[API] Chat error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message || 'Chat failed' })}\n\n`);
      res.end();
    }
  });

  // GET /api/sessions/:id/skills - 获取会话技能（暂时返回空数组）
  app.get('/api/sessions/:id/skills', async (req: Request, res: Response) => {
    res.json([]);
  });

  // GET /api/admin/agents - 管理接口：Agent 列表
  app.get('/api/admin/agents', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM agents ORDER BY created_at DESC');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch admin agents:', err);
      res.status(500).json({ error: 'Failed to fetch agents' });
    }
  });

  // GET /api/admin/users - 管理接口：用户列表
  app.get('/api/admin/users', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch users:', err);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  // GET /api/admin/llm-configs - 管理接口：LLM 配置
  app.get('/api/admin/llm-configs', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM llm_configs ORDER BY created_at DESC');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch llm configs:', err);
      res.status(500).json({ error: 'Failed to fetch LLM configs' });
    }
  });

  // GET /api/admin/runs - 管理接口：运行记录
  app.get('/api/admin/runs', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM traces ORDER BY started_at DESC LIMIT 100');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch runs:', err);
      res.status(500).json({ error: 'Failed to fetch runs' });
    }
  });

  // GET /api/skills - 技能列表
  app.get('/api/skills', async (req: Request, res: Response) => {
    if (!pool) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }
    try {
      const { rows } = await pool.query('SELECT * FROM skills WHERE is_active = true ORDER BY name');
      res.json(rows);
    } catch (err) {
      console.error('[API] Failed to fetch skills:', err);
      res.status(500).json({ error: 'Failed to fetch skills' });
    }
  });

  // 需要 runtime 的路由
  if (runtime) {
    app.use(createChatRouter(() => runtime!));
  } else {
    // 无 runtime 时返回 503
    app.post('/chat', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'Agent runtime not initialized (no database connection)' });
    });
  }

  if (sessionManager) {
    app.use(createSessionsRouter(() => sessionManager!));
  } else {
    // 无 sessionManager 时返回 503
    app.get('/sessions', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'Session manager not initialized (no database connection)' });
    });
    app.post('/sessions', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'Session manager not initialized (no database connection)' });
    });
  }

  // SPA 路由: 非 API 路由返回 index.html
  app.get('*', (req: Request, res: Response) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) {
      if (existsSync(publicDir)) {
        res.sendFile(join(publicDir, 'index.html'));
        return;
      }
    }
    res.status(404).json({ error: 'Not found' });
  });

  // 全局错误处理
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[HTTP] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ─── 6. 启动服务器 ───

  const server = app.listen(PORT, () => {
    console.log('');
    console.log(`  🚀 Server listening on http://0.0.0.0:${PORT}`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    POST /chat          — SSE streaming chat');
    console.log('    GET  /sessions       — List sessions');
    console.log('    POST /sessions       — Create session');
    console.log('    GET  /sessions/:id   — Get session detail');
    console.log('    DELETE /sessions/:id — Delete session');
    console.log('    GET  /health         — Health check');
    console.log('');
    if (DEV_AUTH_BYPASS) {
      console.log('  ⚠️  DEV_AUTH_BYPASS enabled — authentication is skipped');
    }
    console.log('');
  });

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, shutting down...`);
    server.close();
    if (pool) {
      await pool.end();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ─── 启动 ───

main().catch((err) => {
  console.error('[Server] Fatal error during startup:', err);
  process.exit(1);
});
