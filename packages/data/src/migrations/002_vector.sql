-- 002_vector.sql — pgvector 向量表（记忆系统）

-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- L1 会话记忆（短期，pgvector）
CREATE TABLE IF NOT EXISTS memory_l1 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  content TEXT NOT NULL,
  embedding vector(1536),  -- text-embedding-3-small 默认维度
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_l1_user_id ON memory_l1 (user_id);
CREATE INDEX IF NOT EXISTS idx_memory_l1_session_id ON memory_l1 (session_id);

-- HNSW 索引（Cosine 相似度）
CREATE INDEX IF NOT EXISTS idx_memory_l1_embedding
  ON memory_l1 USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- L2 压缩记忆（长期，摘要向量）
CREATE TABLE IF NOT EXISTS memory_l2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  summary TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_l2_user_id ON memory_l2 (user_id);

CREATE INDEX IF NOT EXISTS idx_memory_l2_embedding
  ON memory_l2 USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- RLS: 已禁用，应用层通过 user_id 查询做隔离
ALTER TABLE memory_l1 DISABLE ROW LEVEL SECURITY;
ALTER TABLE memory_l2 DISABLE ROW LEVEL SECURITY;
