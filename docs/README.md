# zhonggui-core 部署文档

> 版本: v0.1.0
> 日期: 2026-06-22
> 作者: Hermes Agent

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 系统要求](#2-系统要求)
- [3. 快速部署](#3-快速部署)
- [4. Docker 部署](#4-docker-部署)
- [5. 环境变量配置](#5-环境变量配置)
- [6. API 接口文档](#6-api-接口文档)
- [7. 端口清单](#7-端口清单)
- [8. 数据库表结构](#8-数据库表结构)
- [9. 常见问题](#9-常见问题)
- [10. 运维手册](#10-运维手册)

---

## 1. 项目概述

zhonggui-core 是中规院智能体的核心服务，提供：

- **Agent 运行时**: 执行 AI Agent 会话，管理工具调用
- **会话管理**: 创建、存储、恢复对话会话
- **SSE 流式对话**: 实时流式返回 AI 响应
- **静态文件服务**: 直接服务前端页面

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    zhonggui-core                         │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   前端页面   │    │  HTTP 服务   │    │  Agent 运行时│ │
│  │  (静态文件)  │◄──►│  (Express)  │◄──►│  (agent-core)│ │
│  └─────────────┘    └──────┬──────┘    └──────┬──────┘ │
│                            │                  │         │
│                     ┌──────▼──────┐    ┌──────▼──────┐ │
│                     │  PostgreSQL │    │   Valkey    │ │
│                     │  (数据库)   │    │   (缓存)    │ │
│                     └─────────────┘    └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 系统要求

| 组件 | 最低要求 | 推荐配置 |
|------|---------|---------|
| 操作系统 | Linux (Debian/Ubuntu) | Debian 13+ |
| CPU | 2核 | 4核 |
| 内存 | 4GB | 8GB |
| 磁盘 | 20GB | 50GB SSD |
| Docker | 24.0+ | 29.0+ |
| Node.js | 22.0+ | 22.x LTS |

---

## 3. 快速部署

### 3.1 文件清单

部署需要以下文件：

```
zhonggui-core/
├── docs/                    # 本文档目录
│   ├── README.md           # 本文件
│   ├── API.md              # API 接口文档
│   ├── PORTS.md            # 端口清单
│   └── DATABASE.md         # 数据库表结构
├── Dockerfile              # Docker 构建配置
├── docker-compose.yml      # Docker Compose 编排
├── init.sql                # 数据库初始化脚本
├── .env.example            # 环境变量模板
└── zhonggui-core-latest.tar.gz  # Docker 镜像 (167MB)
```

### 3.2 传输文件到目标服务器

```bash
# 方式一: SCP 传输
scp zhonggui-core-latest.tar.gz user@server:/opt/
scp -r docs/ Dockerfile docker-compose.yml init.sql .env.example user@server:/opt/zhonggui-core/

# 方式二: rsync 传输
rsync -avz --progress zhonggui-core/ user@server:/opt/zhonggui-core/
```

### 3.3 加载 Docker 镜像

```bash
cd /opt
docker load < zhonggui-core-latest.tar.gz
```

验证镜像加载成功：

```bash
docker images zhonggui-core
# 应该看到:
# REPOSITORY       TAG       IMAGE ID       CREATED        SIZE
# zhonggui-core    latest    xxxxxxxxxxxx   x minutes ago  906MB
```

---

## 4. Docker 部署

### 4.1 一键部署 (推荐)

```bash
cd /opt/zhonggui-core

# 1. 复制环境变量模板
cp .env.example .env

# 2. 编辑环境变量
nano .env

# 3. 启动所有服务
docker compose up -d

# 4. 查看服务状态
docker compose ps

# 5. 查看日志
docker compose logs -f core
```

### 4.2 手动部署

如果不使用 docker-compose，可以手动启动每个服务：

```bash
# 1. 启动 PostgreSQL
docker run -d \
  --name zhonggui-core-postgres \
  -e POSTGRES_DB=zhonggui_core \
  -e POSTGRES_USER=zhonggui \
  -e POSTGRES_PASSWORD=your_password \
  -p 5433:5432 \
  -v $(pwd)/init.sql:/docker-entrypoint-initdb.d/init.sql:ro \
  --restart unless-stopped \
  pgvector/pgvector:pg16

# 2. 启动 Valkey (使用 host 网络)
docker run -d \
  --name zhonggui-core-valkey \
  --network host \
  --restart unless-stopped \
  valkey/valkey:7-alpine --port 6380

# 3. 启动 zhonggui-core
docker run -d \
  --name zhonggui-core-server \
  -p 3002:3000 \
  --env-file .env \
  --add-host=host.docker.internal:host-gateway \
  --restart unless-stopped \
  zhonggui-core:latest
```

### 4.3 验证部署

```bash
# 健康检查
curl http://localhost:3002/health

# 期望输出:
# {"status":"ok","version":"0.1.0","checks":{"postgres":{"status":"connected"}}}

# 测试登录
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'

# 测试创建会话
curl -X POST http://localhost:3002/api/agents/00000000-0000-0000-0000-000000000001/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"测试会话"}'
```

---

## 5. 环境变量配置

### 5.1 必需配置

```bash
# 服务器
NODE_ENV=development          # development | production
PORT=3000                     # 服务端口

# PostgreSQL
PG_HOST=127.0.0.1            # ⚠️ 必须用 127.0.0.1，不要用 localhost
PG_PORT=5433                  # PostgreSQL 端口
PG_DATABASE=zhonggui_core     # 数据库名
PG_USER=zhonggui              # 数据库用户
PG_PASSWORD=your_password     # 数据库密码

# Valkey
VALKEY_HOST=127.0.0.1        # ⚠️ 必须用 127.0.0.1
VALKEY_PORT=6380              # Valkey 端口
```

### 5.2 LLM 配置

```bash
# 主模型
MODEL_NAME=mimo-v2.5-pro
MODEL_PROVIDER=openai
MODEL_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MODEL_API_KEY=your_api_key

# 备用模型 (可选)
LLM_FALLBACK_MODEL=mimo-v2.5
LLM_FALLBACK_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
LLM_FALLBACK_API_KEY=your_api_key
```

### 5.3 安全配置

```bash
# JWT 密钥 (生产环境必须修改!)
JWT_SECRET=your_jwt_secret_at_least_32_chars
REFRESH_SECRET=your_refresh_secret_at_least_32_chars

# 开发模式 (生产环境设为 false)
DEV_AUTH_BYPASS=*** 管理员用户 (逗号分隔)
ADMIN_USERS=admin
```

---

## 6. API 接口文档

详见 [API.md](./API.md)

---

## 7. 端口清单

详见 [PORTS.md](./PORTS.md)

---

## 8. 数据库表结构

详见 [DATABASE.md](./DATABASE.md)

---

## 9. 常见问题

### 9.1 Valkey 连接失败 (ECONNRESET/EPIPE)

**原因**: Docker bridge 网络无法访问 host 网络

**解决方案**: 使用 host 网络模式启动 Valkey

```bash
docker rm -f zhonggui-core-valkey
docker run -d --name zhonggui-core-valkey \
  --network host \
  --restart unless-stopped \
  valkey/valkey:7-alpine --port 6380
```

### 9.2 PostgreSQL 密码认证失败

**原因**: `localhost` 解析为 IPv6 (::1)，但 Docker 只绑定 IPv4

**解决方案**: 将 .env 中的 `localhost` 改为 `127.0.0.1`

```bash
PG_HOST=127.0.0.1
VALKEY_HOST=127.0.0.1
```

### 9.3 登录返回 404

**原因**: 后端未添加 `/auth/login` 路由

**解决方案**: 使用最新版本的 zhonggui-core 镜像

### 9.4 工具调用返回 stub

**原因**: 使用了旧版本的 stub sandbox

**解决方案**: 使用最新版本的 zhonggui-core 镜像（已实现真正的代码执行）

### 9.5 Docker 构建失败 (EAI_AGAIN)

**原因**: Docker bridge 网络无法访问外网

**解决方案**: 使用 host 网络构建

```bash
docker build --network host -t zhonggui-core:latest .
```

---

## 10. 运维手册

### 10.1 服务管理

```bash
# 启动服务
docker compose up -d

# 停止服务
docker compose down

# 重启服务
docker compose restart core

# 查看日志
docker compose logs -f core

# 查看资源占用
docker stats zhonggui-core-server
```

### 10.2 数据库备份

```bash
# 备份
docker exec zhonggui-core-postgres \
  pg_dump -U zhonggui zhonggui_core > backup_$(date +%Y%m%d).sql

# 恢复
cat backup_20260622.sql | \
  docker exec -i zhonggui-core-postgres psql -U zhonggui zhonggui_core
```

### 10.3 健康检查

```bash
# 手动检查
curl http://localhost:3002/health

# 自动检查脚本
cat > /opt/zhonggui-core/check-health.sh << 'EOF'
#!/bin/bash
RESPONSE=$(curl -s http://localhost:3002/health)
STATUS=$(echo $RESPONSE | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
if [ "$STATUS" != "ok" ]; then
  echo "ALERT: zhonggui-core status is $STATUS"
  # 发送告警通知
fi
EOF
chmod +x /opt/zhonggui-core/check-health.sh

# 添加到 crontab (每5分钟检查)
echo "*/5 * * * * /opt/zhonggui-core/check-health.sh >> /var/log/zhonggui-health.log 2>&1" | crontab -
```

### 10.4 日志管理

```bash
# 查看实时日志
docker compose logs -f core

# 查看最近 100 行日志
docker compose logs --tail 100 core

# 导出日志
docker compose logs core > /var/log/zhonggui-core-$(date +%Y%m%d).log
```

---

## 附录: 快速命令参考

```bash
# 启动
docker compose up -d

# 停止
docker compose down

# 重启
docker compose restart core

# 日志
docker compose logs -f core

# 健康检查
curl http://localhost:3002/health

# 登录测试
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin"}'

# 创建会话
curl -X POST http://localhost:3002/api/agents/00000000-0000-0000-0000-000000000001/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"测试"}'

# 发送消息 (SSE)
curl -N -X POST http://localhost:3002/api/agents/00000000-0000-0000-0000-000000000001/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<会话ID>","message":"你好"}'
```
