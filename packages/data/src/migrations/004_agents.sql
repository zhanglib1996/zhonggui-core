-- Migration 004: Agent 平台核心表
-- 创建时间: 2026-06-13

-- 1. LLM 配置表
CREATE TABLE IF NOT EXISTS llm_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  default_params JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. MCP 服务器表
CREATE TABLE IF NOT EXISTS mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  transport VARCHAR(20) NOT NULL CHECK (transport IN ('http', 'stdio', 'sse')),
  url TEXT,
  command TEXT,
  args JSONB DEFAULT '[]',
  env JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Agent 配置表
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  llm_config_id UUID REFERENCES llm_configs(id) ON DELETE SET NULL,
  system_prompt TEXT NOT NULL,
  max_tool_calls INT DEFAULT 10,
  max_conversation_turns INT DEFAULT 50,
  max_context_tokens INT DEFAULT 100000,
  max_tool_concurrency INT DEFAULT 5,
  override_model VARCHAR(100),
  sandbox_policy JSONB NOT NULL DEFAULT '{"file":{"allowed":["/tmp/*"],"readonly":[],"denied":["/etc/*","/root/*"]},"network":{"mode":"open"},"shell":{"mode":"safe","allowedCommands":["ls","cat","echo","pwd","grep","find","wc","head","tail","sort","uniq"]},"database":{"mode":"disabled","allowedTables":[]}}',
  is_active BOOLEAN DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_created_by ON agents (created_by);
CREATE INDEX IF NOT EXISTS idx_agents_is_active ON agents (is_active);

-- 4. Agent-Skill 关联表
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  is_default BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, skill_id)
);

-- 5. Agent-MCP 关联表
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, mcp_server_id)
);

-- 6. Agent 运行记录表
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  model_used VARCHAR(100),
  total_tokens INT,
  duration_ms INT,
  tool_call_count INT DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_id ON agent_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id ON agent_runs (session_id);

-- 7. Agent 运行事件表
CREATE TABLE IF NOT EXISTS agent_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB NOT NULL,
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_id ON agent_run_events (run_id, created_at);

-- 8. 用户 Skill 追加记录表
CREATE TABLE IF NOT EXISTS session_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'conflict')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, skill_id)
);

-- 9. sessions 表扩展
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions (agent_id);

-- 10. skills 表扩展
ALTER TABLE skills ADD COLUMN IF NOT EXISTS requires TEXT DEFAULT '';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS conflicts TEXT DEFAULT '';
