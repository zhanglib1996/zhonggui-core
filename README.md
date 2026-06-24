# 中规院智能体核心 (zhonggui-core)

> Agent Core + Data + Shared 模块，从 zhonggui-V3 项目独立提取

## 项目结构

```
zhonggui-core/
├── packages/
│   ├── agent-core/          # 智能体核心引擎
│   │   ├── src/
│   │   │   ├── index.ts           # 入口文件
│   │   │   ├── runtime.ts         # Agent 运行时
│   │   │   ├── session.ts         # 会话管理
│   │   │   ├── tool.ts            # 工具定义
│   │   │   ├── tool-registry.ts   # 工具注册表
│   │   │   ├── tracer.ts          # 追踪器
│   │   │   ├── context-manager.ts # 上下文管理
│   │   │   ├── middleware.ts      # 中间件
│   │   │   ├── failover-middleware.ts # 熔断中间件
│   │   │   ├── builtin-tools.ts   # 内置工具
│   │   │   ├── yaml-parser.ts     # YAML 解析器
│   │   │   ├── sandbox-policy.ts  # 沙箱策略
│   │   │   ├── agent-factory.ts   # Agent 工厂
│   │   │   └── postgres-tracer.ts # PostgreSQL 追踪
│   │   └── dist/                  # 构建产物
│   │
│   ├── data/                # 数据层 (PostgreSQL + Valkey + SeaweedFS)
│   │   ├── src/
│   │   └── dist/
│   │
│   └── shared/              # 共享工具和类型
│       └── src/
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
└── .env
```

## 核心功能

### Agent Core (智能体核心)

- **Agent 运行时**: 执行 Agent 会话，管理工具调用
- **会话管理**: 创建、存储、恢复会话
- **工具注册**: 动态注册和管理工具
- **中间件系统**: 可扩展的请求处理管道
- **熔断器**: LLM 调用失败时的降级策略
- **追踪器**: 记录 Agent 执行过程
- **上下文管理**: 管理对话上下文和历史
- **YAML 解析**: 解析 Skill 定义文件
- **沙箱策略**: 控制代码执行环境

### Data (数据层)

- **PostgreSQL**: 主数据库，支持 pgvector 向量搜索
- **Valkey (Redis)**: 缓存和会话存储
- **SeaweedFS**: 文件存储

### Shared (共享模块)

- 共享类型定义
- 工具函数
- 常量

## 快速开始

### 1. 安装依赖

```bash
cd /home/zhang/zhonggui-core
export PATH="$HOME/.hermes/node/bin:$PATH"
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入实际配置
```

### 3. 构建项目

```bash
pnpm build
```

### 4. 运行测试

```bash
pnpm test
```

## 开发

### 添加新工具

1. 在 `packages/agent-core/src/builtin-tools.ts` 中定义工具
2. 在工具注册表中注册
3. 在 Agent 运行时中使用

### 添加新中间件

1. 在 `packages/agent-core/src/middleware.ts` 中定义中间件接口
2. 实现中间件逻辑
3. 在运行时中配置中间件管道

## 依赖关系

```
agent-core
    ├── @zhonggui/data (peerDependency)
    └── @zhonggui/shared (peerDependency)

data
    ├── pg (PostgreSQL)
    ├── ioredis (Valkey/Redis)
    └── minio (SeaweedFS)

shared
    └── (无外部依赖)
```

## 构建产物

- `packages/agent-core/dist/index.js` - Agent Core ESM 模块
- `packages/agent-core/dist/index.d.ts` - TypeScript 类型定义
- `packages/data/dist/index.js` - Data ESM 模块
- `packages/data/dist/index.d.ts` - TypeScript 类型定义

## 版本

- Agent Core: v0.3.0
- Data: v0.1.0
- Shared: v1.0.0

## 许可证

私有项目，仅供中规院内部使用
