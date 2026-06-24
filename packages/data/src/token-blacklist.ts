/**
 * Token 黑名单服务
 * - cleanup(): 删除过期记录
 * - add(token, expiresAt): 添加黑名单记录
 * - isBlacklisted(token): 查询是否在黑名单中
 */

import type { Pool } from 'pg';

export class TokenBlacklistService {
  constructor(private pool: Pool) {}

  /**
   * 清理过期的黑名单记录
   * SQL: DELETE FROM token_blacklist WHERE expires_at < NOW()
   */
  async cleanup(): Promise<number> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM token_blacklist WHERE expires_at < NOW()'
    );
    return rowCount ?? 0;
  }

  /**
   * 添加 token 到黑名单
   * @param jti - JWT ID (jti claim)
   * @param expiresAt - 过期时间
   */
  async add(jti: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO token_blacklist (jti, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, expiresAt]
    );
  }

  /**
   * 查询 token 是否在黑名单中
   * @param jti - JWT ID (jti claim)
   */
  async isBlacklisted(jti: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM token_blacklist WHERE jti = $1',
      [jti]
    );
    return rows.length > 0;
  }
}
