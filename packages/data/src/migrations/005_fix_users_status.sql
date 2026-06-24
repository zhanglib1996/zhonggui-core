-- 005_fix_users_status.sql — 修复 users 表缺少 status 列
-- P0-2: routes/users.ts 查询/更新 status 列，但原表未定义

-- 添加 status 列
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

-- 更新现有用户
UPDATE users SET status = 'active' WHERE status IS NULL;

-- 添加约束
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'disabled', 'suspended'));
