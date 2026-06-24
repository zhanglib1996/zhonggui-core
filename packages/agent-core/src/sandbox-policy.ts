/**
 * 沙箱策略双层防护
 *
 * 第一层: SandboxPolicyMiddleware — Agent 中间件，工具调用前快速拒绝
 * 第二层: PolicyEnforcedSandbox — 执行层包装器，代码注入策略检查
 */

import type {
  AgentMiddleware,
  ToolContext,
  SandboxProvider,
  ExecOptions,
  ExecResult,
} from './index.js';
import type { SandboxPolicy } from '@zhonggui/shared';

// ════════════════════════════════════════════════════════════
// 第一层: SandboxPolicyMiddleware (中间件快速拒绝)
// ════════════════════════════════════════════════════════════

const DANGEROUS_PATTERNS: RegExp[] = [
  /bash\s+-c/i,
  /sh\s+-c/i,
  /[|]/,
  /\$\(/,
  /`/,
  /&&/,
  /\|\|/,
  /;/,
];

const DEFAULT_ALLOWED_COMMANDS = [
  'ls', 'cat', 'echo', 'pwd', 'grep', 'find', 'wc',
  'head', 'tail', 'sort', 'uniq',
];

export class SandboxPolicyMiddleware implements AgentMiddleware {
  name = 'sandbox-policy';

  constructor(private policy: SandboxPolicy) {}

  async beforeToolCall(ctx: ToolContext): Promise<ToolContext> {
    const toolName = ctx.toolName;
    const args = ctx.args;

    // Shell 权限检查
    if (toolName === 'run_shell') {
      if (this.policy.shell.mode === 'disabled') {
        throw new Error('Shell execution is disabled by sandbox policy');
      }
      if (this.policy.shell.mode === 'safe') {
        const cmd = String(args.command || '');
        const cmdParts = cmd.trim().split(/\s+/);
        const commandPath = cmdParts[0] ?? '';
        const commandName = commandPath.split('/').pop() ?? commandPath; // get basename
        const allowed = this.policy.shell.allowedCommands || DEFAULT_ALLOWED_COMMANDS;
        if (!allowed.includes(commandName)) {
          throw new Error(`Command '${commandName}' not in allowed list`);
        }
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(cmd)) {
            throw new Error(`Command contains dangerous pattern: ${pattern}`);
          }
        }
      }
    }

    // 文件权限检查（标记元数据，由第二层执行层拦截）
    if (toolName === 'run_python' || toolName === 'run_node') {
      ctx.metadata._sandboxPolicy = this.policy;
    }

    // 数据库权限检查
    if (this.policy.database.mode === 'disabled') {
      const dbTools = ['run_sql', 'query_database', 'execute_sql'];
      if (dbTools.some(t => toolName.includes(t))) {
        throw new Error('Database access is disabled by sandbox policy');
      }
    }

    return ctx;
  }
}

// ════════════════════════════════════════════════════════════
// 第二层: PolicyEnforcedSandbox (执行层权威策略)
// ════════════════════════════════════════════════════════════


/** 沙箱策略拒绝的统一结果（DRY 辅助函数） */
function blockedResult(stderr: string): ExecResult {
  return { stdout: '', stderr, exitCode: 1, durationMs: 0, timedOut: false, oom: false };
}

export class PolicyEnforcedSandbox implements SandboxProvider {
  constructor(
    private inner: SandboxProvider,
    private policy: SandboxPolicy,
  ) {}

  async runPython(code: string, opts?: ExecOptions): Promise<ExecResult> {
    const policyCheck = this.generatePolicyCheck('python');
    const wrappedCode = policyCheck + '\n' + code;
    return this.inner.runPython(wrappedCode, opts);
  }

  async runShell(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    // 已在 SandboxPolicyMiddleware 中检查，这里再做一次双重确认
    if (this.policy.shell.mode === 'disabled') {
      return blockedResult('Shell execution is disabled by sandbox policy');
    }
    if (this.policy.shell.mode === 'safe') {
      const cmdParts = cmd.trim().split(/\s+/);
      const commandPath = cmdParts[0] ?? '';
      const commandName = commandPath.split('/').pop() ?? commandPath; // get basename
      const allowed = this.policy.shell.allowedCommands || DEFAULT_ALLOWED_COMMANDS;
      if (!allowed.includes(commandName)) {
        return blockedResult(`Command '${commandName}' not in allowed list`);
        }
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
          return blockedResult(`Command contains dangerous pattern: ${pattern}`);
          }
      }
    }
    return this.inner.runShell(cmd, opts);
  }

  async runNode(code: string, opts?: ExecOptions): Promise<ExecResult> {
    const policyCheck = this.generatePolicyCheck('node');
    const wrappedCode = policyCheck + '\n' + code;
    return this.inner.runNode(wrappedCode, opts);
  }

  private generatePolicyCheck(lang: 'python' | 'node'): string {
    if (lang === 'python') {
      const denied = this.policy.file.denied;
      return `
import builtins, os, re as _re, sys
sys.modules['subprocess'] = None
sys.modules['importlib'] = None
delattr(os, 'system')
delattr(os, 'popen')
_denied = ${JSON.stringify(denied)}
_real_open = builtins.open
def _safe_open(path, *args, **kwargs):
    import os.path
    p = os.path.realpath(str(path))
    for d in _denied:
        if _re.match(d.replace('*', '.*'), p):
            raise PermissionError(f'Access denied by sandbox policy: {p}')
    return _real_open(path, *args, **kwargs)
builtins.open = _safe_open
`.trim();
    }

    if (lang === 'node') {
      const denied = this.policy.file.denied;
      return `
const _fs = require('fs');
const _path = require('path');
const _denied = ${JSON.stringify(denied)};
const _realReadFileSync = _fs.readFileSync;
_fs.readFileSync = function(p, ...args) {
  const rp = _path.resolve(String(p));
  for (const d of _denied) {
    const pattern = new RegExp('^' + d.replace(/\\*/g, '.*') + '$');
    if (pattern.test(rp)) {
      throw new Error('Access denied by sandbox policy: ' + rp);
    }
  }
  return _realReadFileSync.call(this, p, ...args);
};
// Block async fs methods
_fs.readFile = function() { throw new Error('fs.readFile blocked by sandbox'); };
try { Object.defineProperty(_fs, 'promises', { value: new Proxy(_fs.promises || {}, { get: function(t, p) { return function() { throw new Error('fs.promises.' + String(p) + ' blocked by sandbox'); }; } }), configurable: true }); } catch(e) {}
_fs.createReadStream = function() { throw new Error('fs.createReadStream blocked by sandbox'); };
// Block child_process
const _cp = require('child_process');
_cp.exec = function() { throw new Error('child_process.exec blocked by sandbox'); };
_cp.spawn = function() { throw new Error('child_process.spawn blocked by sandbox'); };
_cp.execFile = function() { throw new Error('child_process.execFile blocked by sandbox'); };
_cp.execSync = function() { throw new Error('child_process.execSync blocked by sandbox'); };
_cp.spawnSync = function() { throw new Error('child_process.spawnSync blocked by sandbox'); };
// Filter sensitive env vars
const _sensitiveKeys = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PRIVATE', 'OPENAI', 'ANTHROPIC', 'DATABASE_URL'];
const _origEnv = process.env;
const _proxyEnv = new Proxy(_origEnv, {
  get(target, prop) {
    if (typeof prop === 'string' && _sensitiveKeys.some(k => prop.toUpperCase().includes(k))) {
      return undefined;
    }
    return target[prop];
  },
  has(target, prop) {
    if (typeof prop === 'string' && _sensitiveKeys.some(k => prop.toUpperCase().includes(k))) {
      return false;
    }
    return prop in target;
  },
});
Object.defineProperty(process, 'env', { value: _proxyEnv, configurable: true });
`.trim();
    }

    return '';
  }
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

/** 创建沙箱策略中间件 */
export function createSandboxPolicyMiddleware(policy: SandboxPolicy): SandboxPolicyMiddleware {
  return new SandboxPolicyMiddleware(policy);
}

/** 创建策略强化沙箱 */
export function createPolicyEnforcedSandbox(
  inner: SandboxProvider,
  policy: SandboxPolicy,
): PolicyEnforcedSandbox {
  return new PolicyEnforcedSandbox(inner, policy);
}
