/**
 * AgentFactory — 从 PG 数据库加载 Agent 配置，组装 AgentRuntime 实例
 *
 * 职责:
 * 1. 按 agentId 从 DB 查询 agent + llm_configs + skills + mcp_servers
 * 2. 调用 createAgentRuntime() 组装实例
 * 3. 5 分钟内存缓存（configHash = agentId:updatedAt 判断变更）
 *
 * M2 修复说明:
 *   AgentFactory 缓存的是基础 Agent 配置（不含用户追加的 Skill）。
 *   用户追加的 Skill 在每次 chat 时从 session_skills 表动态注入，不走缓存。
 */

import type { Pool } from '@zhonggui/data';
import type {
  AgentRuntime,
  AgentOptions,
  AgentTool,
  ModelTarget,
  SandboxProvider,
  SessionManager,
  ToolRegistry,
  Tracer,
} from './index.js';
import { createAgentRuntime } from './runtime.js';
import { createToolRegistry } from './tool-registry.js';

/** Skill 工具解析接口（由 @zhonggui/skill 的 SkillService 实现） */
interface SkillToolParser {
  parseSkillTools(content: string): AgentTool[];
}

// ════════════════════════════════════════════════════════════
// 缓存结构
// ════════════════════════════════════════════════════════════

interface CachedAgent {
  runtime: AgentRuntime;
  configHash: string;
  cachedAt: number;
  lastAccessedAt: number;
}

// ════════════════════════════════════════════════════════════
// DB 行类型
// ════════════════════════════════════════════════════════════

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  llm_config_id: string | null;
  system_prompt: string;
  max_tool_calls: number;
  max_conversation_turns: number;
  max_context_tokens: number;
  max_tool_concurrency: number;
  override_model: string | null;
  sandbox_policy: Record<string, unknown>;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  // JOIN fields from llm_configs
  llm_provider: string | null;
  llm_model: string | null;
  llm_base_url: string | null;
  llm_api_key: string | null;
  default_params: Record<string, unknown> | null;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  content: string;
  is_default: boolean;
  requires: string | null;
  conflicts: string | null;
}

interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  transport: 'http' | 'stdio' | 'sse';
  url: string | null;
  command: string | null;
  args: unknown;
  env: unknown;
}

// ════════════════════════════════════════════════════════════
// 缓存常量
// ════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX_SIZE = 100; // LRU 最大缓存数量

// ════════════════════════════════════════════════════════════
// AgentFactory
// ════════════════════════════════════════════════════════════

export class AgentFactory {
  private pool: Pool;
  private cache = new Map<string, CachedAgent>();
  // P3 #14: singleflight — 相同 agentId 的并发请求复用同一个 Promise
  private inflight = new Map<string, Promise<AgentRuntime>>();

  // 外部注入的依赖（由 assembly 层设置）
  private _sessionManager?: SessionManager;
  private _sandboxProvider?: SandboxProvider;
  private _tracers?: Tracer[];
  private _skillService?: SkillToolParser;
  // 全局模型默认值（当 DB 中 llm_configs 没有对应字段时使用）
  private _defaultApiKey?: string;
  private _defaultBaseURL?: string;
  private _defaultModel?: string;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** 注入 SessionManager（assembly 层调用） */
  setSessionManager(sm: SessionManager): this {
    this._sessionManager = sm;
    return this;
  }

  /** 注入 SandboxProvider（assembly 层调用） */
  setSandboxProvider(sp: SandboxProvider): this {
    this._sandboxProvider = sp;
    return this;
  }

  /** 注入全局 Tracer 列表（assembly 层调用） */
  setTracers(tracers: Tracer[]): this {
    this._tracers = tracers;
    return this;
  }

  /** 注入 SkillService（assembly 层调用，用于解析 Skill 工具） */
  setSkillService(skillService: SkillToolParser): this {
    this._skillService = skillService;
    return this;
  }

  /** 注入全局模型默认值（当 DB 中 llm_configs 没有对应字段时 fallback） */
  setModelDefaults(opts: { apiKey?: string; baseURL?: string; model?: string }): this {
    if (opts.apiKey) this._defaultApiKey = opts.apiKey;
    if (opts.baseURL) this._defaultBaseURL = opts.baseURL;
    if (opts.model) this._defaultModel = opts.model;
    return this;
  }

  // ─── 核心方法 ───

  /**
   * 获取或创建 AgentRuntime 实例（使用外部注入的 SandboxProvider）
   *
   * 与 getOrCreate 类似，但使用传入的 sandboxProvider 替代全局默认的。
   * 用于每用户一沙箱场景：每个用户有自己的沙箱实例。
   *
   * 注意：带 sandbox 的 runtime 不走缓存（每个用户的沙箱不同）
   */
  async getOrCreateWithSandbox(
    agentId: string,
    sandboxProvider: SandboxProvider,
  ): Promise<AgentRuntime> {
    // 从 DB 加载完整 Agent 配置
    const { agent, skills, mcpServers } = await this.loadAgentFromDB(agentId);

    // 组装 AgentRuntime（使用外部传入的 sandboxProvider）
    return this.assembleRuntime(agent, skills, mcpServers, sandboxProvider);
  }

  /**
   * 获取或创建 AgentRuntime 实例
   *
   * 1. 检查内存缓存 (Map<string, CachedAgent>)
   * 2. 缓存命中且未过期(5分钟TTL) → 直接返回 runtime
   * 3. 缓存未命中 → 从 DB 查询 agent + 关联的 llm_configs + skills + mcp_servers
   * 4. 用查到的配置调用 createAgentRuntime() 创建实例
   * 5. 存入缓存并返回
   */
  async getOrCreate(agentId: string): Promise<AgentRuntime> {
    const cached = this.cache.get(agentId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      cached.lastAccessedAt = Date.now();
      return cached.runtime;
    }

    // P3 #14: singleflight — 并发请求复用同一个 Promise
    const existing = this.inflight.get(agentId);
    if (existing) return existing;

    const promise = this._doCreate(agentId);
    this.inflight.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(agentId);
    }
  }

  private async _doCreate(agentId: string): Promise<AgentRuntime> {
    const cached = this.cache.get(agentId);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      cached.lastAccessedAt = Date.now();
      return cached.runtime;
    }

    // 从 DB 加载完整 Agent 配置
    const { agent, skills, mcpServers } = await this.loadAgentFromDB(agentId);

    // 构建 configHash
    const configHash = `${agent.id}:${agent.updated_at}`;

    // 如果缓存存在且 configHash 未变，刷新 TTL 后返回
    if (cached && cached.configHash === configHash) {
      cached.cachedAt = Date.now();
      cached.lastAccessedAt = Date.now();
      return cached.runtime;
    }

    // 组装 AgentRuntime
    const runtime = this.assembleRuntime(agent, skills, mcpServers);

    // LRU 驱逐：超过最大限制时删除最久未访问的条目
    if (this.cache.size >= CACHE_MAX_SIZE) {
      this.evictLRU();
    }

    // 存入缓存
    this.cache.set(agentId, {
      runtime,
      configHash,
      cachedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    return runtime;
  }

  /**
   * LRU 驱逐：删除最久未访问的条目
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * 清除指定 agent 的缓存
   */
  invalidateCache(agentId: string): void {
    this.cache.delete(agentId);
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存大小（调试用）
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  // ─── DB 查询 ───

  private async loadAgentFromDB(agentId: string): Promise<{
    agent: AgentRow;
    skills: SkillRow[];
    mcpServers: McpServerRow[];
  }> {
    // 并行查询 agent + llm_config、skills、mcp_servers
    const [agentResult, skillsResult, mcpResult] = await Promise.all([
      this.pool.query<AgentRow>(
        `SELECT a.*,
                lc.provider  AS llm_provider,
                lc.model     AS llm_model,
                lc.base_url  AS llm_base_url,
                lc.api_key   AS llm_api_key,
                lc.default_params
         FROM agents a
         LEFT JOIN llm_configs lc ON a.llm_config_id = lc.id
         WHERE a.id = $1 AND a.is_active = true`,
        [agentId],
      ),
      this.pool.query<SkillRow>(
        `SELECT s.*, as2.is_default
         FROM agent_skills as2
         JOIN skills s ON as2.skill_id = s.id
         WHERE as2.agent_id = $1`,
        [agentId],
      ),
      this.pool.query<McpServerRow>(
        `SELECT ms.*
         FROM agent_mcp_servers ams
         JOIN mcp_servers ms ON ams.mcp_server_id = ms.id
         WHERE ams.agent_id = $1`,
        [agentId],
      ),
    ]);

    const agent = agentResult.rows[0];
    if (!agent) {
      throw new Error(`Agent not found or inactive: ${agentId}`);
    }

    return {
      agent,
      skills: skillsResult.rows,
      mcpServers: mcpResult.rows,
    };
  }

  // ─── 组装 Runtime ───

  private assembleRuntime(
    agent: AgentRow,
    skills: SkillRow[],
    _mcpServers: McpServerRow[],
    overrideSandbox?: SandboxProvider,
  ): AgentRuntime {
    // 1. 构建 ModelTarget（DB 优先，fallback 到全局默认值）
    const baseModel: ModelTarget = {
      provider: agent.llm_provider ?? 'openai',
      model: agent.llm_model ?? this._defaultModel ?? 'gpt-4o',
      baseURL: agent.llm_base_url ?? this._defaultBaseURL ?? undefined,
      apiKey: agent.llm_api_key ?? this._defaultApiKey ?? undefined,
    };

    // 2. 构建 ToolRegistry（从 skills 解析工具）
    const toolRegistry = createToolRegistry();

    // 解析 skills YAML/Markdown 中的工具定义并注册到 toolRegistry
    if (this._skillService) {
      for (const skill of skills) {
        const skillTools = this._skillService.parseSkillTools(skill.content);
        for (const tool of skillTools) {
          toolRegistry.register(tool);
        }
      }
    }

    // 3. 构建 AgentOptions
    const options: AgentOptions = {
      baseModel,
      sessionManager: this._sessionManager ?? createStubSessionManager(),
      toolRegistry,
      sandbox: overrideSandbox ?? this._sandboxProvider ?? createStubSandboxProvider(),
      systemPrompt: agent.system_prompt,
      maxToolCalls: agent.max_tool_calls,
      maxConversationTurns: agent.max_conversation_turns,
      maxContextTokens: agent.max_context_tokens,
      maxToolConcurrency: agent.max_tool_concurrency,
      overrideModel: agent.override_model ?? undefined,
      tracers: this._tracers,
    };

    // 4. 创建 runtime
    return createAgentRuntime(options);
  }
}

// ╀── Stub 实现（延迟注入占位） ───

function createStubSessionManager(): SessionManager {
  const notImplemented = () => {
    throw new Error('SessionManager not injected. Call setSessionManager() first.');
  };
  return {
    create: notImplemented as () => Promise<string>,
    resume: notImplemented as () => Promise<null>,
    destroy: notImplemented as () => Promise<void>,
    list: notImplemented as () => Promise<never[]>,
    addMessage: notImplemented as () => Promise<void>,
    getMessages: notImplemented as () => Promise<never[]>,
  };
}

function createStubSandboxProvider(): SandboxProvider {
  const notImplemented = () => {
    throw new Error('SandboxProvider not injected. Call setSandboxProvider() first.');
  };
  return {
    runPython: notImplemented as () => Promise<never>,
    runShell: notImplemented as () => Promise<never>,
    runNode: notImplemented as () => Promise<never>,
  };
}

// ╀── 工厂函数 ───

export function createAgentFactory(pool: Pool): AgentFactory {
  return new AgentFactory(pool);
}
