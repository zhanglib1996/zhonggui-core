import type { Pool } from 'pg';
import { ApiKeyCrypto } from './crypto.js';

export interface LLMConfigRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  default_params: Record<string, unknown>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export class LLMConfigService {
  private crypto: ApiKeyCrypto | null = null;

  constructor(
    private pool: Pool,
    private encryptionKey?: string,
  ) {}

  /** 初始化加密器（必须在使用加密功能前调用） */
  async initCrypto(): Promise<void> {
    if (this.encryptionKey) {
      this.crypto = new ApiKeyCrypto(this.encryptionKey);
      await this.crypto.init();
    }
  }

  /** 加密 api_key（如果有加密器） */
  private async encryptKey(plaintext: string): Promise<string> {
    if (!this.crypto) return plaintext;
    return this.crypto.encrypt(plaintext);
  }

  /** 解密 api_key（降级模式：解密失败则返回原文） */
  private async decryptKey(encrypted: string): Promise<string> {
    if (!this.crypto) return encrypted;
    try {
      return await this.crypto.decrypt(encrypted);
    } catch {
      // 解密失败 → 可能是明文存储的旧数据，返回原文
      return encrypted;
    }
  }

  /** 脱敏 api_key：只显示前 8 位 */
  static maskKey(key: string): string {
    if (!key) return '';
    return key.length > 8 ? key.slice(0, 8) + '...' : key;
  }

  async list(): Promise<LLMConfigRow[]> {
    const { rows } = await this.pool.query(
      'SELECT id, name, provider, model, base_url, api_key, default_params, is_active, created_at, updated_at FROM llm_configs WHERE is_active = true ORDER BY created_at DESC'
    );
    // 列表返回脱敏后的 key
    return rows.map((row: LLMConfigRow) => ({
      ...row,
      api_key: LLMConfigService.maskKey(row.api_key),
    }));
  }

  async getById(id: string): Promise<LLMConfigRow | null> {
    const { rows } = await this.pool.query(
      'SELECT id, name, provider, model, base_url, api_key, default_params, is_active, created_at, updated_at FROM llm_configs WHERE id = $1',
      [id]
    );
    if (!rows[0]) return null;
    const row = rows[0] as LLMConfigRow;
    // 解密后返回
    row.api_key = await this.decryptKey(row.api_key);
    return row;
  }

  async create(data: {
    name: string;
    provider: string;
    model: string;
    base_url: string;
    api_key: string;
    default_params?: Record<string, unknown>;
  }): Promise<LLMConfigRow> {
    const encryptedKey = await this.encryptKey(data.api_key);
    const { rows } = await this.pool.query(
      `INSERT INTO llm_configs (name, provider, model, base_url, api_key, default_params)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        data.name,
        data.provider,
        data.model,
        data.base_url,
        encryptedKey,
        JSON.stringify(data.default_params || {}),
      ]
    );
    return rows[0];
  }

  async update(
    id: string,
    data: Partial<Pick<LLMConfigRow, 'name' | 'provider' | 'model' | 'base_url' | 'api_key' | 'default_params'>>
  ): Promise<LLMConfigRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(data)) {
      if (['name', 'provider', 'model', 'base_url'].includes(key)) {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      } else if (key === 'api_key') {
        fields.push(`api_key = $${idx++}`);
        values.push(await this.encryptKey(val as string));
      } else if (key === 'default_params') {
        fields.push(`default_params = $${idx++}`);
        values.push(JSON.stringify(val));
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await this.pool.query(
      `UPDATE llm_configs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE llm_configs SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    return (rowCount ?? 0) > 0;
  }
}
