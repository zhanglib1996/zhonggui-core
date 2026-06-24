/**
 * 用户空间联合初始化（PG + SeaweedFS）
 * 首次登录时自动创建用户记录和文件桶
 */

import type pg from 'pg';
import type { SeaweedFSClient } from './seaweedfs.js';

/**
 * 初始化用户空间
 * 1. PostgreSQL upsert 用户记录
 * 2. SeaweedFS 创建用户专属桶
 */
export async function initUserSpace(
  pool: pg.Pool,
  seaweedfs: SeaweedFSClient,
  userId: string,
): Promise<void> {
  // 并行执行 PG 和 SeaweedFS 初始化
  await Promise.all([
    // PG: upsert 用户记录
    pool.query(
      `INSERT INTO users (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    ),
    // SeaweedFS: 创建用户桶
    seaweedfs.createUserBucket(userId),
  ]);
}
