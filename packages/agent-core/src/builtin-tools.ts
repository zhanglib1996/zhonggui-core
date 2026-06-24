/**
 * 内置工具实现 — 使用 YAML 定义 + binding 模式
 *
 * 参考 NexAU 的内置工具设计
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tool, ToolCollection } from './tool.js';
import type { ToolBinding } from './tool.js';

// ════════════════════════════════════════════════════════════
// 内置工具绑定实现
//
// 注意: run_python / run_shell / run_node 已在 runtime.ts 中直接注册，
// 此处不再重复定义绑定，避免工具重复注册。
// 如需扩展新的内置工具，在此处添加绑定并在 builtinBindings 中映射。
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════════
// 工具注册
// ════════════════════════════════════════════════════════════

/** 获取内置工具目录路径 */
function getToolsDir(): string {
  // 尝试使用 import.meta.url（ESM）
  try {
    const currentDir = fileURLToPath(new URL('.', import.meta.url));
    return join(currentDir, '..', 'tools');
  } catch {
    // 回退到相对路径
    return join(__dirname, '..', 'tools');
  }
}

/**
 * 内置工具绑定映射
 *
 * run_python / run_shell / run_node 已在 runtime.ts 的 createAgentRuntime() 中直接注册，
 * 此映射仅用于扩展新的内置工具（通过 YAML + binding 模式）。
 */
const builtinBindings: Record<string, ToolBinding> = {};

/**
 * 加载所有内置工具（扩展用）
 *
 * 注意: run_python/run_shell/run_node 已在 runtime.ts 中注册，
 * 此函数仅用于加载扩展的内置工具。
 */
export function loadBuiltinTools(): Tool[] {
  const toolsDir = getToolsDir();
  const collection = ToolCollection.fromDirectory(toolsDir, builtinBindings);
  return collection.all();
}

/**
 * 加载内置工具到集合
 */
export function loadBuiltinToolCollection(): ToolCollection {
  const toolsDir = getToolsDir();
  return ToolCollection.fromDirectory(toolsDir, builtinBindings);
}

/**
 * 创建单个内置工具
 */
export function createBuiltinTool(name: string): Tool | undefined {
  const toolsDir = getToolsDir();
  const binding = builtinBindings[name];

  if (!binding) {
    return undefined;
  }

  const yamlPath = join(toolsDir, `${name}.tool.yaml`);
  return Tool.fromYAML(yamlPath, binding);
}
