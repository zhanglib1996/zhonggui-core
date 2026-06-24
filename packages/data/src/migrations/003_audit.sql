-- 003_audit.sql — 审计日志表

-- 操作日志
CREATE TABLE IF NOT EXISTS operation_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_user_id ON operation_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs (action);

-- Token 统计
CREATE TABLE IF NOT EXISTS token_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_stats_user_id ON token_stats (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_stats_model ON token_stats (model, created_at DESC);

-- 错误日志
CREATE TABLE IF NOT EXISTS error_logs (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  user_id TEXT,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_error_logs_trace_id ON error_logs (trace_id);
CREATE INDEX IF NOT EXISTS idx_error_logs_user_id ON error_logs (user_id, created_at DESC);

-- 审计日志（数据变更追踪）
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id, created_at DESC);
