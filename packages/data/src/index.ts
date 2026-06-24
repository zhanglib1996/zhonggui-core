/**
 * @zhonggui/data — 基础设施层
 * PostgreSQL + pgvector + Valkey + SeaweedFS
 */

// ─── Branded Types（编译期用户数据隔离）───
export type UserId = string & { readonly __brand: 'UserId' };
export type SessionId = string & { readonly __brand: 'SessionId' };

/** 将普通字符串转为 UserId（用于反序列化外部输入） */
export function asUserId(id: string): UserId {
  return id as UserId;
}

/** 将普通字符串转为 SessionId */
export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

// ─── PostgreSQL ───
export { createPool, migrate, getVectorStore } from './postgres.js';
export type { Pool } from 'pg';
export type { PgConfig, VectorStore, VectorRecord, VectorSearchResult } from './postgres.js';

// ─── Valkey ───
export { createValkey, createRateLimiter } from './valkey.js';
export type { ValkeyConfig, ValkeyClient, RateLimiter } from './valkey.js';

// ─── SeaweedFS ───
export { createSeaweedFS } from './seaweedfs.js';
export type { SeaweedFSConfig, SeaweedFSClient, FileInfo } from './seaweedfs.js';

// ─── 用户空间联合初始化 ───
export { initUserSpace } from './user-space.js';

// ─── API Key 加密 ───
export { ApiKeyCrypto } from './crypto.js';

// ─── LLM 配置 CRUD ───
export { LLMConfigService } from './llm-configs.js';
export type { LLMConfigRow } from './llm-configs.js';

// ─── MCP Server CRUD ───
export { MCPServerService } from './mcp-servers.js';
export type { MCPServerRow } from './mcp-servers.js';

// ─── Token 黑名单清理 ───
export { TokenBlacklistService } from './token-blacklist.js';

// ─── RLS ───
export { createRLSPolicy, enableRLS, setUserContext } from './postgres.js';
