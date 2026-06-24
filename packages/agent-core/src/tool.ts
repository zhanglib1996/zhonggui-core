/**
 * Tool 类 — 参考 NexAU 的 Tool.from_yaml() 设计
 *
 * 支持：
 * - 从 YAML 文件加载工具定义
 * - 定义与实现分离（binding 模式）
 * - Deferred loading（延迟加载）
 * - Extra kwargs（预设参数）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentTool, SandboxProvider } from './index.js';
import {
  parseToolYAML,
  parseToolYAMLContent,
  resolveEnvVars,
  mergeExtraKwargs,
} from './yaml-parser.js';
import type { ToolYAMLDefinition } from './yaml-parser.js';

// ════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════

/** 工具绑定函数 */
export type ToolBinding = (
  args: Record<string, unknown>,
  sandbox: SandboxProvider,
) => Promise<unknown>;

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading: boolean;
  searchHint?: string;
  formatter?: string;
  extraKwargs?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════
// Tool 类
// ════════════════════════════════════════════════════════════

export class Tool {
  /** 工具定义 */
  readonly definition: ToolDefinition;

  /** 工具绑定函数 */
  readonly binding: ToolBinding;

  /** YAML 文件路径（可选） */
  readonly yamlPath?: string;

  constructor(definition: ToolDefinition, binding: ToolBinding, yamlPath?: string) {
    this.definition = definition;
    this.binding = binding;
    this.yamlPath = yamlPath;
  }

  /**
   * 从 YAML 文件加载工具定义
   *
   * @example
   * ```typescript
   * const tool = Tool.fromYAML('tools/WebSearch.tool.yaml', webSearchImpl);
   * ```
   */
  static fromYAML(yamlPath: string, binding: ToolBinding): Tool {
    const resolvedPath = resolve(yamlPath);
    const yamlDef = parseToolYAML(resolvedPath);
    const definition = Tool.yamlToDefinition(yamlDef);
    return new Tool(definition, binding, resolvedPath);
  }

  /**
   * 从 YAML 内容创建工具定义
   *
   * @example
   * ```typescript
   * const yamlContent = `
   * name: calculator
   * description: 计算数学表达式
   * `;
   * const tool = Tool.fromYAMLContent(yamlContent, calculatorImpl);
   * ```
   */
  static fromYAMLContent(content: string, binding: ToolBinding): Tool {
    const yamlDef = parseToolYAMLContent(content);
    const definition = Tool.yamlToDefinition(yamlDef);
    return new Tool(definition, binding);
  }

  /**
   * 直接创建工具
   *
   * @example
   * ```typescript
   * const tool = Tool.create({
   *   name: 'calculator',
   *   description: '计算数学表达式',
   *   parameters: { expression: { type: 'string' } },
   * }, calculatorImpl);
   * ```
   */
  static create(
    config: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      deferLoading?: boolean;
      searchHint?: string;
    },
    binding: ToolBinding,
  ): Tool {
    const definition: ToolDefinition = {
      name: config.name,
      description: config.description,
      inputSchema: config.parameters,
      deferLoading: config.deferLoading ?? false,
      searchHint: config.searchHint,
    };
    return new Tool(definition, binding);
  }

  /**
   * 转换为 AgentTool（用于 ToolRegistry 注册）
   */
  toAgentTool(): AgentTool {
    const { definition, binding } = this;

    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
      execute: async (args: Record<string, unknown>, sandbox: SandboxProvider) => {
        // 合并 extra_kwargs
        const mergedArgs = mergeExtraKwargs(args, definition.extraKwargs);
        return binding(mergedArgs, sandbox);
      },
    };
  }

  /**
   * 检查是否应该延迟加载
   */
  isDeferred(): boolean {
    return this.definition.deferLoading;
  }

  /**
   * 获取搜索提示
   */
  getSearchHint(): string {
    return this.definition.searchHint || this.definition.description;
  }

  /**
   * 转换为 JSON（用于序列化）
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.definition.name,
      description: this.definition.description,
      inputSchema: this.definition.inputSchema,
      deferLoading: this.definition.deferLoading,
      searchHint: this.definition.searchHint,
      yamlPath: this.yamlPath,
    };
  }

  /** 将 YAML 定义转换为 ToolDefinition */
  private static yamlToDefinition(yamlDef: ToolYAMLDefinition): ToolDefinition {
    return {
      name: yamlDef.name,
      description: yamlDef.description,
      inputSchema: yamlDef.input_schema,
      deferLoading: yamlDef.defer_loading ?? false,
      searchHint: yamlDef.search_hint,
      formatter: yamlDef.formatter,
      extraKwargs: yamlDef.extra_kwargs,
    };
  }
}

// ════════════════════════════════════════════════════════════
// 工具集合
// ════════════════════════════════════════════════════════════

/** 工具集合管理器 */
export class ToolCollection {
  private tools = new Map<string, Tool>();

  /** 添加工具 */
  add(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  /** 获取工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 获取所有工具 */
  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 获取即时加载的工具 */
  eager(): Tool[] {
    return this.all().filter((t) => !t.isDeferred());
  }

  /** 获取延迟加载的工具 */
  deferred(): Tool[] {
    return this.all().filter((t) => t.isDeferred());
  }

  /** 搜索工具 */
  search(query: string): Tool[] {
    const lowerQuery = query.toLowerCase();
    return this.all().filter((t) => {
      const hint = t.getSearchHint().toLowerCase();
      const name = t.definition.name.toLowerCase();
      return hint.includes(lowerQuery) || name.includes(lowerQuery);
    });
  }

  /** 转换为 AgentTool 数组 */
  toAgentTools(): AgentTool[] {
    return this.eager().map((t) => t.toAgentTool());
  }

  /** 从目录加载所有工具定义 */
  static fromDirectory(dirPath: string, bindings: Record<string, ToolBinding>): ToolCollection {
    const collection = new ToolCollection();
    const resolvedDir = resolve(dirPath);

    if (!existsSync(resolvedDir)) {
      return collection;
    }

    const files = readdirSync(resolvedDir)
      .filter((f) => f.endsWith('.tool.yaml') || f.endsWith('.tool.yml'));

    for (const file of files) {
      const yamlPath = join(resolvedDir, file);
      const toolName = file.replace(/\.tool\.ya?ml$/, '');
      const binding = bindings[toolName];

      if (binding) {
        const tool = Tool.fromYAML(yamlPath, binding);
        collection.add(tool);
      }
    }

    return collection;
  }
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export function createTool(yamlPath: string, binding: ToolBinding): Tool {
  return Tool.fromYAML(yamlPath, binding);
}

export function createToolCollection(): ToolCollection {
  return new ToolCollection();
}
