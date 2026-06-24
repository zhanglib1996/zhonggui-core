/**
 * PostgreSQL + pgvector 基础设施
 */

import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { UserId } from './index.js';

// ─── 配置 ───

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;           // 连接池最大连接数，默认 20
  idleTimeout?: number;   // 空闲超时 ms，默认 30000
}

// ─── 连接池 ───

export function createPool(config: PgConfig): pg.Pool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? 20,
    idleTimeoutMillis: config.idleTimeout ?? 30000,
  });

  // 启动时检查 pgvector 扩展（仅首次连接执行）
  let pgvectorChecked = false;
  pool.on('connect', async (client) => {
    if (!pgvectorChecked) {
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        pgvectorChecked = true;
      } catch (err) {
        console.warn('[pgvector] Extension check failed:', (err as Error).message);
      }
    }
  });

  return pool;
}

// ─── 迁移 ───

export async function migrate(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  // 创建迁移记录表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows: applied } = await pool.query<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY id',
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedNames: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedNames.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return appliedNames;
}

// ─── pgvector 向量存储 ───

export interface VectorRecord {
  id?: string;
  userId: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  insert(table: string, record: VectorRecord): Promise<void>;
  search(
    table: string,
    embedding: number[],
    topK: number,
    filter: Record<string, unknown>,
  ): Promise<VectorSearchResult[]>;
  createIndex(
    table: string,
    column: string,
    m?: number,
    efConstruction?: number,
  ): Promise<void>;
}

/** 验证 SQL 标识符（表名/列名），只允许字母、数字、下划线 */
function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: "${name}"`);
  }
  return name;
}

export function getVectorStore(pool: pg.Pool): VectorStore {
  return {
    async insert(table, record) {
      const t = validateIdentifier(table);
      const id = record.id ?? crypto.randomUUID();
      await pool.query(
        `INSERT INTO ${t} (id, user_id, content, embedding, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          record.userId,
          record.content,
          JSON.stringify(record.embedding),
          JSON.stringify(record.metadata ?? {}),
          record.createdAt ?? new Date(),
        ],
      );
    },

    async search(table, embedding, topK, filter) {
      const t = validateIdentifier(table);
      const filterKeys = Object.keys(filter);
      let whereClause = '';
      const params: unknown[] = [JSON.stringify(embedding), topK];

      if (filterKeys.length > 0) {
        const conditions = filterKeys.map((key, i) => {
          params.push(filter[key]);
          return `${validateIdentifier(key)} = $${i + 3}`;
        });
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }

      const { rows } = await pool.query<{
        id: string;
        content: string;
        similarity: number;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, content,
                1 - (embedding <=> $1::vector) AS similarity,
                metadata
         FROM ${t}
         ${whereClause}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        params,
      );

      return rows;
    },

    async createIndex(table, column, m = 16, efConstruction = 64) {
      const t = validateIdentifier(table);
      const col = validateIdentifier(column);
      const indexName = `idx_${t}_${col}_hnsw`;
      await pool.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${t} USING hnsw (${col} vector_cosine_ops)
        WITH (m = ${m}, ef_construction = ${efConstruction})
      `);
    },
  };
}

// ─── Row-Level Security (RLS) ───

export async function createRLSPolicy(
  pool: pg.Pool,
  tableName: string,
  userIdColumn = 'user_id',
): Promise<void> {
  const t = validateIdentifier(tableName);
  const col = validateIdentifier(userIdColumn);
  await pool.query(`
    CREATE POLICY IF NOT EXISTS user_isolation_${t}
    ON ${t}
    USING (${col} = current_setting('app.current_user_id', true))
  `);
}

export async function enableRLS(pool: pg.Pool, tableName: string): Promise<void> {
  const t = validateIdentifier(tableName);
  await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
}

export async function setUserContext(pool: pg.Pool, userId: UserId): Promise<void> {
  await pool.query('SET app.current_user_id = $1', [userId]);
}
