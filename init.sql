-- zhonggui-core 数据库初始化脚本
-- PostgreSQL + pgvector
-- 所有 ID 使用 TEXT 类型（兼容 nanoid）

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    username VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    avatar_url TEXT,
    role VARCHAR(50) DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent 表
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT,
    avatar_url TEXT,
    config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    title VARCHAR(500),
    model VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT,
    role VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id VARCHAR(255),
    name VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- 记忆表
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
ON memories USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- LLM 配置表
CREATE TABLE IF NOT EXISTS llm_configs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(100) NOT NULL,
    model VARCHAR(255) NOT NULL,
    base_url TEXT,
    api_key TEXT,
    config JSONB DEFAULT '{}',
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- MCP 服务器配置表
CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name VARCHAR(255) NOT NULL,
    transport VARCHAR(50) NOT NULL,
    command TEXT,
    args JSONB DEFAULT '[]',
    url TEXT,
    env JSONB DEFAULT '{}',
    config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Skill 表
CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    version VARCHAR(50) DEFAULT '1.0.0',
    content TEXT NOT NULL,
    tools JSONB DEFAULT '[]',
    config JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 运行记录表
CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'running',
    input JSONB,
    output JSONB,
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_traces_session_id ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_user_id ON traces(user_id);
CREATE INDEX IF NOT EXISTS idx_traces_started_at ON traces(started_at);

-- Token 黑名单表
CREATE TABLE IF NOT EXISTS token_blacklist (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires_at ON token_blacklist(expires_at);

-- 初始数据
INSERT INTO users (id, username, display_name, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', '管理员', 'admin')
ON CONFLICT (username) DO NOTHING;

INSERT INTO agents (id, name, description, system_prompt)
VALUES ('00000000-0000-0000-0000-000000000001', '规划分析助手', '中规院智能体 - 城市规划分析专家',
        '你是中规院规划分析专家，专注于城市规划、土地利用、交通规划、人口预测等领域。请用专业但易懂的语言回答用户问题。')
ON CONFLICT DO NOTHING;

INSERT INTO llm_configs (name, provider, model, base_url, is_default)
VALUES ('DeepSeek V4 Flash', 'openai', 'deepseek-v4-flash', 'https://api.deepseek.com/v1', true)
ON CONFLICT DO NOTHING;
