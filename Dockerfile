# zhonggui-core Dockerfile
# 多阶段构建，优化镜像大小

# ════════════════════════════════════════════════════════
# 阶段 1: 构建
# ════════════════════════════════════════════════════════
FROM node:22-slim AS builder

ENV CI=true
RUN npm install -g pnpm@11

WORKDIR /app

# 复制 package.json 文件
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/data/package.json packages/data/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# 安装依赖
RUN pnpm install --no-frozen-lockfile && pnpm approve-builds --all

# 复制源码
COPY . .

# 构建所有包
RUN pnpm build

# ════════════════════════════════════════════════════════
# 阶段 2: 生产镜像
# ════════════════════════════════════════════════════════
FROM node:22-slim AS production

ENV CI=true
RUN npm install -g pnpm@11

WORKDIR /app

# 复制 package.json 文件
COPY package.json pnpm-workspace.yaml .npmrc ./
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/data/package.json packages/data/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# 安装生产依赖
RUN pnpm install --prod --no-frozen-lockfile && pnpm approve-builds --all

# 从构建阶段复制构建产物
COPY --from=builder /app/packages/agent-core/dist packages/agent-core/dist
COPY --from=builder /app/packages/data/dist packages/data/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/server/public packages/server/public

# 复制迁移文件
COPY --from=builder /app/packages/data/src/migrations packages/data/src/migrations

# 创建非 root 用户
RUN addgroup --system --gid 1001 zhonggui && \
    adduser --system --uid 1001 zhonggui

# 创建数据目录
RUN mkdir -p /home/zhonggui/.zhonggui/memory /home/zhonggui/.zhonggui/skills && \
    chown -R zhonggui:zhonggui /home/zhonggui

# 切换用户
USER zhonggui

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# 启动服务
CMD ["node", "packages/server/dist/index.js"]
