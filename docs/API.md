# API 接口文档

> zhonggui-core v0.1.0
> 基础地址: http://localhost:3002

---

## 目录

- [认证](#认证)
- [会话管理](#会话管理)
- [对话接口](#对话接口)
- [Agent 管理](#agent-管理)
- [管理接口](#管理接口)
- [健康检查](#健康检查)
- [SSE 事件格式](#sse-事件格式)

---

## 认证

### POST /auth/login

用户登录，获取访问令牌。

**请求:**

```json
{
  "username": "admin"
}
```

**响应 (200):**

```json
{
  "user": {
    "id": "00000000-0000-0000-0000-000000000001",
    "username": "admin",
    "roles": ["admin"]
  },
  "tokens": {
    "accessToken": "cookie-based"
  }
}
```

**错误响应:**

| 状态码 | 说明 |
|--------|------|
| 400 | 用户名为空 |
| 401 | 认证失败 (非 DEV_AUTH_BYPASS 模式) |

**示例:**

```bash
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'
```

---

### POST /auth/logout

用户登出。

**响应 (200):**

```json
{
  "success": true
}
```

**示例:**

```bash
curl -X POST http://localhost:3002/auth/logout
```

---

### GET /auth/me

获取当前登录用户信息。

**响应 (200):**

```json
{
  "id": "00000000-0000-0000-0000-000000000001",
  "username": "admin",
  "roles": ["admin"]
}
```

**错误响应:**

| 状态码 | 说明 |
|--------|------|
| 401 | 未登录 |

**示例:**

```bash
curl http://localhost:3002/auth/me
```

---

## 会话管理

### GET /sessions

获取会话列表。

**查询参数:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| userId | string | 是 | 用户 ID |
| limit | number | 否 | 返回数量 (默认 50) |
| offset | number | 否 | 偏移量 (默认 0) |

**响应 (200):**

```json
{
  "sessions": [
    {
      "id": "skSNK3VwdoZAEquNhpSNs",
      "title": "测试会话",
      "messageCount": 5,
      "createdAt": "2026-06-22T04:52:17.931Z",
      "updatedAt": "2026-06-22T04:52:17.931Z"
    }
  ]
}
```

**示例:**

```bash
curl "http://localhost:3002/sessions?userId=00000000-0000-0000-0000-000000000001"
```

---

### POST /sessions

创建新会话。

**请求:**

```json
{
  "userId": "00000000-0000-0000-0000-000000000001"
}
```

**响应 (201):**

```json
{
  "id": "skSNK3VwdoZAEquNhpSNs",
  "userId": "00000000-0000-0000-0000-000000000001"
}
```

**示例:**

```bash
curl -X POST http://localhost:3002/sessions \
  -H "Content-Type: application/json" \
  -d '{"userId":"00000000-0000-0000-0000-000000000001"}'
```

---

### GET /sessions/:id

获取会话详情（含消息历史）。

**路径参数:**

| 参数 | 说明 |
|------|------|
| id | 会话 ID |

**响应 (200):**

```json
{
  "id": "skSNK3VwdoZAEquNhpSNs",
  "userId": "00000000-0000-0000-0000-000000000001",
  "title": "测试会话",
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "你好",
      "timestamp": "2026-06-22T04:52:17.931Z"
    },
    {
      "id": "msg_002",
      "role": "assistant",
      "content": "你好！有什么可以帮助你的吗？",
      "timestamp": "2026-06-22T04:52:18.123Z"
    }
  ],
  "createdAt": "2026-06-22T04:52:17.931Z",
  "updatedAt": "2026-06-22T04:52:18.123Z"
}
```

**错误响应:**

| 状态码 | 说明 |
|--------|------|
| 404 | 会话不存在 |

**示例:**

```bash
curl http://localhost:3002/sessions/skSNK3VwdoZAEquNhpSNs
```

---

### DELETE /sessions/:id

删除会话。

**路径参数:**

| 参数 | 说明 |
|------|------|
| id | 会话 ID |

**响应:** 204 No Content

**错误响应:**

| 状态码 | 说明 |
|--------|------|
| 404 | 会话不存在 |

**示例:**

```bash
curl -X DELETE http://localhost:3002/sessions/skSNK3VwdoZAEquNhpSNs
```

---

## 对话接口

### POST /api/agents/:id/sessions

为指定 Agent 创建会话。

**路径参数:**

| 参数 | 说明 |
|------|------|
| id | Agent ID |

**请求:**

```json
{
  "title": "测试会话"
}
```

**响应 (200):**

```json
{
  "id": "skSNK3VwdoZAEquNhpSNs",
  "agentId": "00000000-0000-0000-0000-000000000001"
}
```

**示例:**

```bash
curl -X POST http://localhost:3002/api/agents/00000000-0000-0000-0000-000000000001/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"测试会话"}'
```

---

### POST /api/agents/:id/chat

向 Agent 发送消息，获取 SSE 流式响应。

**路径参数:**

| 参数 | 说明 |
|------|------|
| id | Agent ID |

**请求:**

```json
{
  "sessionId": "skSNK3VwdoZAEquNhpSNs",
  "message": "你好"
}
```

**响应:** SSE 流 (text/event-stream)

```
data: {"type":"run_start","content":"dev-user","tools":["run_python","run_shell","run_node"],"traceId":"trace_xxx"}

data: {"type":"text","content":"你"}

data: {"type":"text","content":"好"}

data: {"type":"text","content":"！有什么可以帮助你的吗？"}

data: [DONE]
```

**示例:**

```bash
curl -N -X POST http://localhost:3002/api/agents/00000000-0000-0000-0000-000000000001/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"skSNK3VwdoZAEquNhpSNs","message":"你好"}'
```

---

### GET /api/sessions/:id/skills

获取会话可用的技能列表。

**路径参数:**

| 参数 | 说明 |
|------|------|
| id | 会话 ID |

**响应 (200):**

```json
[]
```

**说明:** 当前返回空数组，技能系统待实现。

---

## Agent 管理

### GET /api/agents

获取所有活跃的 Agent 列表。

**响应 (200):**

```json
[
  {
    "id": "00000000-0000-0000-0000-000000000001",
    "name": "规划分析助手",
    "description": "中规院智能体 - 城市规划分析专家",
    "system_prompt": "你是中规院规划分析专家...",
    "avatar_url": null,
    "config": {},
    "is_active": true,
    "created_at": "2026-06-22T03:39:04.227Z",
    "updated_at": "2026-06-22T03:39:04.227Z"
  }
]
```

**示例:**

```bash
curl http://localhost:3002/api/agents
```

---

## 管理接口

### GET /api/admin/agents

获取所有 Agent（包括非活跃）。

**响应:** 同 `/api/agents`

---

### GET /api/admin/users

获取所有用户。

**响应 (200):**

```json
[
  {
    "id": "00000000-0000-0000-0000-000000000001",
    "username": "admin",
    "display_name": "管理员",
    "role": "admin",
    "created_at": "2026-06-22T03:39:04.227Z"
  }
]
```

---

### GET /api/admin/llm-configs

获取 LLM 配置。

**响应 (200):**

```json
[
  {
    "id": "xxx",
    "name": "DeepSeek V4 Flash",
    "provider": "openai",
    "model": "deepseek-v4-flash",
    "base_url": "https://api.deepseek.com/v1",
    "is_default": true
  }
]
```

---

### GET /api/admin/runs

获取运行记录（最近 100 条）。

**响应 (200):**

```json
[
  {
    "id": "trace_xxx",
    "session_id": "skSNK3VwdoZAEquNhpSNs",
    "user_id": "dev-user",
    "status": "completed",
    "started_at": "2026-06-22T04:52:17.931Z",
    "completed_at": "2026-06-22T04:52:20.123Z",
    "duration_ms": 2192
  }
]
```

---

### GET /api/skills

获取所有活跃的技能。

**响应 (200):**

```json
[]
```

---

## 健康检查

### GET /health

服务健康检查（无需认证）。

**响应 (200):**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 1234,
  "timestamp": "2026-06-22T05:00:00.000Z",
  "checks": {
    "postgres": {
      "status": "connected"
    }
  }
}
```

**错误响应:**

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "checks": {
    "postgres": {
      "status": "error",
      "error": "connection refused"
    }
  }
}
```

**示例:**

```bash
curl http://localhost:3002/health
```

---

## SSE 事件格式

### 事件类型

| 类型 | 说明 | 示例 |
|------|------|------|
| run_start | 运行开始 | `{"type":"run_start","content":"dev-user","tools":[...],"traceId":"xxx"}` |
| text | 文本片段 | `{"type":"text","content":"你"}` |
| tool_call | 工具调用 | `{"type":"tool_call","tool":"run_shell","args":{"command":"ls"}}` |
| tool_call_start | 工具开始执行 | `{"type":"tool_call_start","tool":"run_shell","args":{...}}` |
| tool_call_end | 工具执行完成 | `{"type":"tool_call_end","tool":"run_shell","result":{...}}` |
| tool_result | 工具结果 | `{"type":"tool_result","tool":"run_shell","result":{...}}` |
| error | 错误 | `{"type":"error","content":"错误信息"}` |
| [DONE] | 流结束 | `data: [DONE]` |

### 工具结果格式

```json
{
  "stdout": "命令输出",
  "stderr": "错误输出",
  "exitCode": 0,
  "durationMs": 123
}
```

### 解析示例 (JavaScript)

```javascript
const eventSource = new EventSource('/api/agents/xxx/chat', {
  method: 'POST',
  body: JSON.stringify({ sessionId, message })
});

eventSource.onmessage = (event) => {
  if (event.data === '[DONE]') {
    console.log('对话结束');
    return;
  }
  
  const data = JSON.parse(event.data);
  switch (data.type) {
    case 'text':
      process.stdout.write(data.content);
      break;
    case 'tool_call':
      console.log(`调用工具: ${data.tool}`);
      break;
    case 'error':
      console.error(`错误: ${data.content}`);
      break;
  }
};
```
