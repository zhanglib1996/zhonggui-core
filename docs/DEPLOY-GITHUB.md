# 从 GitHub 部署 zhonggui-core

> 适用于任何安装了 Docker 的 Debian/Ubuntu 服务器

---

## 前置要求

- Debian 12+ 或 Ubuntu 22.04+
- 2 核 CPU / 4GB 内存 / 20GB 磁盘（推荐 4 核 / 8GB）
- root 或 sudo 权限
- 可访问外网（拉取 Docker 镜像和 GitHub 仓库）

---

## 第 1 步：安装 Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 将当前用户加入 docker 组（免 sudo）
sudo usermod -aG docker $USER
newgrp docker

# 验证安装
docker --version
docker compose version
```

---

## 第 2 步：从 GitHub 克隆项目

```bash
cd ~
git clone https://github.com/zhanglib1996/zhonggui-core.git
cd zhonggui-core
```

---

## 第 3 步：配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，修改以下关键配置：

```bash
nano .env
```

```bash
# 服务
NODE_ENV=development
PORT=3000

# PostgreSQL（使用 docker compose 服务名）
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=zhonggui_core
PG_USER=zhonggui
PG_PASSWORD=zhonggui2026

# Valkey（使用 docker compose 服务名）
VALKEY_HOST=valkey
VALKEY_PORT=6379

# JWT（生产环境务必修改！）
JWT_SECRET=dev-jwt-secret-at-least-32-chars-long-2026
REFRESH_SECRET=dev-refresh-secret-at-least-32-chars-2026

# 开发模式（跳过认证，生产环境设为 false）
DEV_AUTH_BYPASS=true
ADMIN_USERS=admin

# LLM 配置（按实际情况填写）
MODEL_NAME=mimo-v2.5-pro
MODEL_PROVIDER=openai
MODEL_BASE_URL=https://your-llm-endpoint/v1
MODEL_API_KEY=your-api-key

# 备用 LLM（可选）
LLM_FALLBACK_MODEL=mimo-v2.5
LLM_FALLBACK_BASE_URL=https://your-llm-endpoint/v1
LLM_FALLBACK_API_KEY=your-api-key
```

> **说明**：`PG_HOST` 和 `VALKEY_HOST` 使用服务名（`postgres` / `valkey`），docker compose 内部 DNS 会自动解析。

---

## 第 4 步：构建 Docker 镜像

```bash
# 使用 host 网络构建，避免 Docker bridge 网络访问外网失败
docker build --network host -t zhonggui-core:latest .
```

构建过程大约需要 3-5 分钟，取决于网络速度。

---

## 第 5 步：启动所有服务

```bash
# 启动 PostgreSQL + Valkey + zhonggui-core
docker compose up -d

# 查看服务状态
docker compose ps

# 查看实时日志
docker compose logs -f core
```

启动后会自动：
- 创建 PostgreSQL 数据库并初始化表结构（`init.sql`）
- 启动 Valkey 缓存服务
- 启动 zhonggui-core 核心服务

---

## 第 6 步：验证部署

```bash
# 健康检查
curl http://localhost:3002/health

# 期望输出：
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

## 常用运维命令

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
docker stats

# 数据库备份
docker exec zhonggui-core-postgres \
  pg_dump -U zhonggui zhonggui_core > backup_$(date +%Y%m%d).sql

# 数据库恢复
cat backup_20260624.sql | \
  docker exec -i zhonggui-core-postgres psql -U zhonggui zhonggui_core

# 更新代码并重新部署
cd ~/zhonggui-core
git pull origin main
docker build --network host -t zhonggui-core:latest .
docker compose up -d
```

---

## 端口说明

| 服务 | 容器端口 | 宿主机端口 | 说明 |
|------|---------|-----------|------|
| zhonggui-core | 3000 | 3002 | HTTP API + 前端页面 |
| PostgreSQL | 5432 | 5433 | 数据库 |
| Valkey | 6379 | 6380 | 缓存 |

---

## 常见问题

### Docker 构建失败 (EAI_AGAIN)

Docker bridge 网络无法访问外网，使用 host 网络构建：

```bash
docker build --network host -t zhonggui-core:latest .
```

### Valkey 连接失败 (ECONNRESET/EPIPE)

确保 `VALKEY_HOST=valkey`（使用服务名），不要用 `localhost` 或 `127.0.0.1`。

### PostgreSQL 认证失败

确保 `PG_HOST=postgres`（使用服务名），不要用 `localhost`。

### 登录返回 404

确保使用最新代码：`git pull origin main` 后重新构建。
