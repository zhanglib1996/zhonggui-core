# 端口清单

> zhonggui-core v0.1.0

---

## 服务端口

| 服务 | 容器端口 | 主机端口 | 协议 | 说明 |
|------|---------|---------|------|------|
| zhonggui-core | 3000 | 3002 | HTTP | 主服务 |
| PostgreSQL | 5432 | 5433 | TCP | 数据库 |
| Valkey | 6379 | 6380 | TCP | 缓存 |

---

## 端口详情

### zhonggui-core (3002)

**用途:** HTTP API 服务 + 前端静态文件

**访问方式:**
- 浏览器: http://localhost:3002/
- API: http://localhost:3002/api/*
- 健康检查: http://localhost:3002/health

**防火墙配置:**

```bash
# 开放端口
sudo ufw allow 3002/tcp

# 仅允许本地访问 (默认)
# 不需要额外配置
```

---

### PostgreSQL (5433)

**用途:** 数据持久化

**访问方式:**
- 主机: 127.0.0.1
- 端口: 5433
- 数据库: zhonggui_core
- 用户: zhonggui

**连接测试:**

```bash
PGPASSWORD=*** psql -h 127.0.0.1 -p 5433 -U zhonggui -d zhonggui_core -c "SELECT 1;"
```

**防火墙配置:**

```bash
# ⚠️ 仅允许本地访问 (默认)
# 生产环境不要开放此端口到外网
```

---

### Valkey (6380)

**用途:** 会话缓存、速率限制

**访问方式:**
- 主机: 127.0.0.1
- 端口: 6380

**连接测试:**

```bash
redis-cli -h 127.0.0.1 -p 6380 ping
# 期望输出: PONG
```

**防火墙配置:**

```bash
# ⚠️ 仅允许本地访问 (默认)
# 生产环境不要开放此端口到外网
```

---

## Docker 网络配置

### 默认配置 (docker-compose.yml)

```yaml
services:
  postgres:
    ports:
      - "5433:5432"  # 主机 5433 → 容器 5432
  
  valkey:
    network_mode: host  # 直接使用主机网络
    # 端口 6380 直接在主机上监听
  
  core:
    ports:
      - "3002:3000"  # 主机 3002 → 容器 3000
    extra_hosts:
      - "host.docker.internal:host-gateway"  # 允许容器访问主机
```

### 网络拓扑

```
┌─────────────────────────────────────────────────────────┐
│                     主机 (Host)                          │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│  │   3002/tcp  │    │   5433/tcp  │    │   6380/tcp  │ │
│  │  zhonggui   │    │  PostgreSQL │    │   Valkey    │ │
│  │    core     │    │    (Docker) │    │  (Host Net) │ │
│  └──────┬──────┘    └──────▲──────┘    └──────▲──────┘ │
│         │                  │                  │         │
│         │           ┌──────┴──────┐    ┌──────┴──────┐ │
│         └──────────►│  127.0.0.1  │◄───│  127.0.0.1  │ │
│                     │    :5433    │    │    :6380    │ │
│                     └─────────────┘    └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 端口冲突处理

### 检查端口占用

```bash
# 检查端口是否被占用
ss -tlnp | grep -E "3002|5433|6380"

# 或使用 lsof
lsof -i:3002
lsof -i:5433
lsof -i:6380
```

### 释放端口

```bash
# 释放端口 3002
fuser -k 3002/tcp

# 释放端口 5433
fuser -k 5433/tcp

# 释放端口 6380
fuser -k 6380/tcp
```

### 修改端口

如果需要修改端口，编辑 `.env` 文件：

```bash
# 修改服务端口
PORT=3003  # 改为 3003

# 修改 PostgreSQL 端口
PG_PORT=5434  # 改为 5434

# 修改 Valkey 端口
VALKEY_PORT=6381  # 改为 6381
```

同时修改 `docker-compose.yml` 中的端口映射：

```yaml
services:
  core:
    ports:
      - "3003:3003"  # 同步修改
  postgres:
    ports:
      - "5434:5432"  # 同步修改
```

---

## 生产环境端口建议

| 服务 | 建议端口 | 说明 |
|------|---------|------|
| zhonggui-core | 3002 | 通过 Nginx 反向代理 |
| PostgreSQL | 5433 | 仅本地访问 |
| Valkey | 6380 | 仅本地访问 |
| Nginx | 80/443 | 对外服务 |

### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;  # SSE 长连接
    }
}
```

---

## 防火墙配置

### UFW (Ubuntu/Debian)

```bash
# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 允许 zhonggui-core (如果需要直接访问)
sudo ufw allow 3002/tcp

# ⚠️ 不要开放数据库端口到外网
# sudo ufw allow 5433/tcp  # 危险!
# sudo ufw allow 6380/tcp  # 危险!
```

### iptables

```bash
# 允许 HTTP/HTTPS
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# 允许 zhonggui-core
iptables -A INPUT -p tcp --dport 3002 -j ACCEPT

# 拒绝数据库端口外部访问
iptables -A INPUT -p tcp --dport 5433 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 5433 -j DROP
iptables -A INPUT -p tcp --dport 6380 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 6380 -j DROP
```
