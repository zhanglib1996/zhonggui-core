# 数据库表结构

> zhonggui-core v0.1.0
> 数据库: PostgreSQL 16 + pgvector
> 编码: UTF-8

---

## 目录

- [表清单](#表清单)
- [users - 用户表](#users---用户表)
- [agents - Agent 配置表](#agents---agent-配置表)
- [sessions - 会话表](#sessions---会话表)
- [messages - 消息表](#messages---消息表)
- [memories - 记忆表](#memories---记忆表)
- [llm_configs - LLM 配置表](#llm_configs---llm-配置表)
- [mcp_servers - MCP 服务器表](#mcp_servers---mcp-服务器表)
- [skills - 技能表](#skills---技能表)
- [traces - 运行记录表](#traces---运行记录表)
- [token_blacklist - Token 黑名单表](#token_blacklist---token-黑名单表)
- [初始数据](#初始数据)
- [常用查询](#常用查询)

---

## 表清单

| 表名 | 说明 | 记录数 |
|------|------|--------|
| users | 用户 | 2 |
| agents | Agent 配置 | 1 |
| sessions | 会话 | - |
| messages | 消息 | - |
| memories | 记忆 (向量) | - |
| llm_configs | LLM 配置 | 1 |
| mcp_servers | MCP 服务器 | - |
| skills | 技能 | - |
| traces | 运行记录 | - |
| token_blacklist | Token 黑名单 | - |

---

## users - 用户表

**说明:** 存储系统用户信息

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 用户 ID |
| username | VARCHAR(255) | UNIQUE, NOT NULL | - | 用户名 |
| display_name | VARCHAR(255) | - | - | 显示名称 |
| avatar_url | TEXT | - | - | 头像 URL |
| role | VARCHAR(50) | - | 'user' | 角色 (admin/user) |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

**索引:**

- `users_pkey` - PRIMARY KEY (id)
- `users_username_key` - UNIQUE (username)

**初始数据:**

```sql
INSERT INTO users (id, username, display_name, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', '管理员', 'admin'),
  ('dev-user', 'dev', 'Development User', 'admin');
```

---

## agents - Agent 配置表

**说明:** 存储 AI Agent 配置

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | Agent ID |
| name | VARCHAR(255) | NOT NULL | - | 名称 |
| description | TEXT | - | - | 描述 |
| system_prompt | TEXT | - | - | 系统提示词 |
| avatar_url | TEXT | - | - | 头像 URL |
| config | JSONB | - | '{}' | 配置 |
| is_active | BOOLEAN | - | true | 是否活跃 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

**索引:**

- `agents_pkey` - PRIMARY KEY (id)

**初始数据:**

```sql
INSERT INTO agents (id, name, description, system_prompt) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '规划分析助手',
  '中规院智能体 - 城市规划分析专家',
  '你是中规院规划分析专家，专注于城市规划、土地利用、交通规划、人口预测等领域。请用专业但易懂的语言回答用户问题。'
);
```

---

## sessions - 会话表

**说明:** 存储用户会话

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | - | 会话 ID (nanoid) |
| user_id | TEXT | FOREIGN KEY → users(id) | - | 用户 ID |
| agent_id | TEXT | FOREIGN KEY → agents(id) | - | Agent ID |
| title | VARCHAR(500) | - | - | 会话标题 |
| model | VARCHAR(255) | - | - | 使用的模型 |
| metadata | JSONB | - | '{}' | 元数据 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

**索引:**

- `sessions_pkey` - PRIMARY KEY (id)
- `idx_sessions_user_id` - INDEX (user_id)
- `idx_sessions_agent_id` - INDEX (agent_id)

**外键:**

- `sessions_user_id_fkey` → users(id) ON DELETE CASCADE
- `sessions_agent_id_fkey` → agents(id) ON DELETE SET NULL

---

## messages - 消息表

**说明:** 存储对话消息

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | - | 消息 ID |
| session_id | TEXT | FOREIGN KEY → sessions(id) | - | 会话 ID |
| user_id | TEXT | - | - | 用户 ID |
| role | VARCHAR(50) | NOT NULL | - | 角色 (user/assistant/system/tool) |
| content | TEXT | NOT NULL | - | 消息内容 |
| tool_calls | JSONB | - | - | 工具调用 |
| tool_call_id | VARCHAR(255) | - | - | 工具调用 ID |
| name | VARCHAR(255) | - | - | 工具名称 |
| metadata | JSONB | - | '{}' | 元数据 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |

**索引:**

- `messages_pkey` - PRIMARY KEY (id)
- `idx_messages_session_id` - INDEX (session_id)
- `idx_messages_created_at` - INDEX (created_at)

**外键:**

- `messages_session_id_fkey` → sessions(id) ON DELETE CASCADE

---

## memories - 记忆表

**说明:** 存储 AI 记忆（支持向量搜索）

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 记忆 ID |
| user_id | TEXT | FOREIGN KEY → users(id) | - | 用户 ID |
| session_id | TEXT | FOREIGN KEY → sessions(id) | - | 会话 ID |
| content | TEXT | NOT NULL | - | 记忆内容 |
| embedding | vector(1536) | - | - | 向量嵌入 |
| metadata | JSONB | - | '{}' | 元数据 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |

**索引:**

- `memories_pkey` - PRIMARY KEY (id)
- `idx_memories_user_id` - INDEX (user_id)
- `idx_memories_session_id` - INDEX (session_id)
- `idx_memories_embedding_hnsw` - HNSW 索引 (embedding)

**外键:**

- `memories_user_id_fkey` → users(id) ON DELETE CASCADE
- `memories_session_id_fkey` → sessions(id) ON DELETE SET NULL

**向量搜索示例:**

```sql
-- 查找最相似的记忆
SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
FROM memories
WHERE user_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

---

## llm_configs - LLM 配置表

**说明:** 存储 LLM 模型配置

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 配置 ID |
| name | VARCHAR(255) | NOT NULL | - | 名称 |
| provider | VARCHAR(100) | NOT NULL | - | 提供商 |
| model | VARCHAR(255) | NOT NULL | - | 模型名称 |
| base_url | TEXT | - | - | API 地址 |
| api_key | TEXT | - | - | API 密钥 |
| config | JSONB | - | '{}' | 配置 |
| is_default | BOOLEAN | - | false | 是否默认 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

---

## mcp_servers - MCP 服务器表

**说明:** 存储 MCP 服务器配置

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 服务器 ID |
| name | VARCHAR(255) | NOT NULL | - | 名称 |
| transport | VARCHAR(50) | NOT NULL | - | 传输方式 (stdio/http/sse) |
| command | TEXT | - | - | 命令 |
| args | JSONB | - | '[]' | 参数 |
| url | TEXT | - | - | URL |
| env | JSONB | - | '{}' | 环境变量 |
| config | JSONB | - | '{}' | 配置 |
| is_active | BOOLEAN | - | true | 是否活跃 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

---

## skills - 技能表

**说明:** 存储 Agent 技能

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 技能 ID |
| name | VARCHAR(255) | UNIQUE, NOT NULL | - | 名称 |
| description | TEXT | - | - | 描述 |
| version | VARCHAR(50) | - | '1.0.0' | 版本 |
| content | TEXT | NOT NULL | - | 内容 |
| tools | JSONB | - | '[]' | 工具列表 |
| config | JSONB | - | '{}' | 配置 |
| is_active | BOOLEAN | - | true | 是否活跃 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |
| updated_at | TIMESTAMPTZ | - | NOW() | 更新时间 |

---

## traces - 运行记录表

**说明:** 存储 Agent 运行记录

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 记录 ID |
| session_id | TEXT | FOREIGN KEY → sessions(id) | - | 会话 ID |
| user_id | TEXT | FOREIGN KEY → users(id) | - | 用户 ID |
| agent_id | TEXT | FOREIGN KEY → agents(id) | - | Agent ID |
| status | VARCHAR(50) | - | 'running' | 状态 (running/completed/failed) |
| input | JSONB | - | - | 输入 |
| output | JSONB | - | - | 输出 |
| metadata | JSONB | - | '{}' | 元数据 |
| started_at | TIMESTAMPTZ | - | NOW() | 开始时间 |
| completed_at | TIMESTAMPTZ | - | - | 完成时间 |
| duration_ms | INTEGER | - | - | 耗时 (毫秒) |

**索引:**

- `traces_pkey` - PRIMARY KEY (id)
- `idx_traces_session_id` - INDEX (session_id)
- `idx_traces_user_id` - INDEX (user_id)
- `idx_traces_started_at` - INDEX (started_at)

---

## token_blacklist - Token 黑名单表

**说明:** 存储已失效的 JWT Token

**表结构:**

| 字段 | 类型 | 约束 | 默认值 | 说明 |
|------|------|------|--------|------|
| id | TEXT | PRIMARY KEY | gen_random_uuid()::text | 记录 ID |
| token_hash | VARCHAR(255) | UNIQUE, NOT NULL | - | Token 哈希 |
| expires_at | TIMESTAMPTZ | NOT NULL | - | 过期时间 |
| created_at | TIMESTAMPTZ | - | NOW() | 创建时间 |

**索引:**

- `token_blacklist_pkey` - PRIMARY KEY (id)
- `token_blacklist_token_hash_key` - UNIQUE (token_hash)
- `idx_token_blacklist_expires_at` - INDEX (expires_at)

---

## 初始数据

### 管理员用户

```sql
INSERT INTO users (id, username, display_name, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', '管理员', 'admin'),
  ('dev-user', 'dev', 'Development User', 'admin');
```

### 默认 Agent

```sql
INSERT INTO agents (id, name, description, system_prompt) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '规划分析助手',
  '中规院智能体 - 城市规划分析专家',
  '你是中规院规划分析专家，专注于城市规划、土地利用、交通规划、人口预测等领域。请用专业但易懂的语言回答用户问题。'
);
```

### 默认 LLM 配置

```sql
INSERT INTO llm_configs (name, provider, model, base_url, is_default) VALUES (
  'DeepSeek V4 Flash',
  'openai',
  'deepseek-v4-flash',
  'https://api.deepseek.com/v1',
  true
);
```

---

## 常用查询

### 查看所有用户

```sql
SELECT id, username, display_name, role, created_at FROM users;
```

### 查看所有 Agent

```sql
SELECT id, name, description, is_active FROM agents;
```

### 查看会话列表

```sql
SELECT s.id, s.title, u.username, a.name as agent_name, s.created_at
FROM sessions s
JOIN users u ON s.user_id = u.id
LEFT JOIN agents a ON s.agent_id = a.id
ORDER BY s.created_at DESC
LIMIT 20;
```

### 查看会话消息

```sql
SELECT m.role, m.content, m.created_at
FROM messages m
WHERE m.session_id = 'xxx'
ORDER BY m.created_at ASC;
```

### 查看运行记录

```sql
SELECT t.id, t.status, t.started_at, t.completed_at, t.duration_ms
FROM traces t
ORDER BY t.started_at DESC
LIMIT 20;
```

### 清理过期 Token

```sql
DELETE FROM token_blacklist WHERE expires_at < NOW();
```

### 清理旧会话 (30天前)

```sql
DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '30 days';
```
