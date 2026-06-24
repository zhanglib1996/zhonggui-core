/**
 * API Key 加密工具 — AES-256-GCM
 *
 * 使用 scrypt 从密码派生密钥，AES-256-GCM 加密/解密。
 * 固定 salt 避免每次加密需要存储 salt。
 */

import { randomBytes, createCipheriv, createDecipheriv, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export class ApiKeyCrypto {
  private key!: Buffer;

  constructor(private secret: string) {}

  async init(): Promise<void> {
    // 使用固定 salt（从 secret 派生），避免每次加密需要存储 salt
    const salt = Buffer.from('zhonggui-agent-api-key-salt-v1');
    this.key = (await scryptAsync(this.secret, salt, 32)) as Buffer;
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  async decrypt(encryptedBase64: string): Promise<string> {
    const data = Buffer.from(encryptedBase64, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  }
}
