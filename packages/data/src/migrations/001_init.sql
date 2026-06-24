-- 001_init.sql — 核心业务表

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  email TEXT,
  department TEXT,
  roles TEXT[] DEFAULT '{}',
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_external_id ON users (external_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);

-- 对话消息表
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls JSONB,
  tool_call_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages (user_id);

-- Skill 表
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  manifest JSONB NOT NULL,
  markdown TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'private' CHECK (permissions IN ('private', 'team', 'public')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_user_id ON skills (user_id);

-- Skill 权限授予表
CREATE TABLE IF NOT EXISTS skill_grants (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'use')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(skill_id, target_user_id)
);

-- Token 黑名单（登出/刷新轮转时废弃旧 Token）
CREATE TABLE IF NOT EXISTS token_blacklist (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist (expires_at);

-- RLS: 已禁用，应用层通过 user_id 查询做隔离
-- 如果需要行级安全策略，可重新启用并创建相应 POLICY
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE skills DISABLE ROW LEVEL SECURITY;
