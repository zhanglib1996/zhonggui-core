import type { Pool } from 'pg';
import { URL } from 'node:url';
import { isIPv4 } from 'node:net';

// SSRF 防护：内网 IP + metadata 端点检查
function isPrivateOrReservedIP(hostname: string): boolean {
  // 本地回环
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return true;
  }
  // metadata 端点
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return true;
  }
  // IPv4 内网地址检查
  if (isIPv4(hostname)) {
    const parts = hostname.split('.').map(Number);
    const p0 = parts[0]!;
    const p1 = parts[1]!;
    // 10.0.0.0/8
    if (p0 === 10) return true;
    // 172.16.0.0/12
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    // 192.168.0.0/16
    if (p0 === 192 && p1 === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (p0 === 169 && p1 === 254) return true;
    // 127.0.0.0/8
    if (p0 === 127) return true;
  }
  return false;
}

function validateUrl(urlString: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }
  // 只允许 http/https 协议
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Protocol not allowed: ${parsed.protocol}` };
  }
  // 检查内网/保留 IP
  const hostname = parsed.hostname;
  if (isPrivateOrReservedIP(hostname)) {
    return { ok: false, error: 'Access to internal/private network is not allowed' };
  }
  return { ok: true };
}

export interface MCPServerRow {
  id: string;
  name: string;
  description: string | null;
  transport: 'http' | 'stdio' | 'sse';
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export class MCPServerService {
  constructor(private pool: Pool) {}

  async list(): Promise<MCPServerRow[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM mcp_servers WHERE is_active = true ORDER BY created_at DESC'
    );
    return rows;
  }

  async getById(id: string): Promise<MCPServerRow | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM mcp_servers WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  async create(data: {
    name: string;
    description?: string;
    transport: 'http' | 'stdio' | 'sse';
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }): Promise<MCPServerRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO mcp_servers (name, description, transport, url, command, args, env)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.name,
        data.description || null,
        data.transport,
        data.url || null,
        data.command || null,
        JSON.stringify(data.args || []),
        JSON.stringify(data.env || {}),
      ]
    );
    return rows[0];
  }

  async update(
    id: string,
    data: Partial<Pick<MCPServerRow, 'name' | 'description' | 'transport' | 'url' | 'command' | 'args' | 'env' | 'is_active'>>
  ): Promise<MCPServerRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const simpleCols = ['name', 'description', 'transport', 'url', 'command', 'is_active'];
    const jsonCols = ['args', 'env'];

    for (const [key, val] of Object.entries(data)) {
      if (simpleCols.includes(key)) {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      } else if (jsonCols.includes(key)) {
        fields.push(`${key} = $${idx++}`);
        values.push(JSON.stringify(val));
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await this.pool.query(
      `UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE mcp_servers SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * 测试 MCP Server 连接
   * - http/sse: HTTP HEAD/GET 请求
   * - stdio: spawn 进程并检查退出码
   */
  async testConnection(id: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const server = await this.getById(id);
    if (!server) return { ok: false, error: 'Server not found' };

    const start = Date.now();

    try {
      if (server.transport === 'http' || server.transport === 'sse') {
        if (!server.url) return { ok: false, error: 'No URL configured' };
        // SSRF 防护：校验 URL 安全性
        const urlCheck = validateUrl(server.url);
        if (!urlCheck.ok) return { ok: false, error: urlCheck.error };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(server.url, {
          method: 'GET',
          signal: controller.signal as any,
        });
        clearTimeout(timeout);
        const latencyMs = Date.now() - start;
        return res.ok
          ? { ok: true, latencyMs }
          : { ok: false, latencyMs, error: `HTTP ${res.status}` };
      }

      if (server.transport === 'stdio') {
        if (!server.command) return { ok: false, error: 'No command configured' };
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
          const child = execFile(
            server.command!,
            server.args || [],
            { timeout: 10_000, env: { ...process.env, ...server.env } },
            (err) => {
              const latencyMs = Date.now() - start;
              if (err && (err as any).killed) {
                resolve({ ok: false, latencyMs, error: 'Timeout' });
              } else {
                // stdio servers are long-lived; if it starts without immediate crash, consider ok
                resolve({ ok: !err || err.code === 0, latencyMs, error: err?.message });
              }
            }
          );
          // Give it 2s to see if it crashes immediately
          setTimeout(() => {
            child.kill();
          }, 2000);
        });
      }

      return { ok: false, error: `Unknown transport: ${server.transport}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
