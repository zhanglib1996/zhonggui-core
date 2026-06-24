/**
 * YAML 解析器 — 解析工具定义和 Skill 元数据
 *
 * 参考 NexAU 的 Tool.from_yaml() 设计
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════

export interface ToolYAMLDefinition {
  type: 'tool';
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      default?: unknown;
      enum?: unknown[];
    }>;
    required?: string[];
    additionalProperties?: boolean;
    $schema?: string;
  };
  defer_loading?: boolean;
  search_hint?: string;
  formatter?: string;
  extra_kwargs?: Record<string, unknown>;
}

export interface SkillFrontmatter {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions?: 'private' | 'team' | 'public';
  tags?: string[];
}

export interface SkillMetadata extends SkillFrontmatter {
  tools: SkillToolMetadata[];
  content: string;
}

export interface SkillToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════
// YAML 解析（简化版，无需外部依赖）
// ════════════════════════════════════════════════════════════

/** 解析简单的 YAML 键值对 */
function parseSimpleYAML(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  for (const line of lines) {
    // 跳过注释和空行
    if (line.trim().startsWith('#') || !line.trim()) continue;

    // 解析 key: value
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      if (key && value !== undefined) {
        // 处理不同类型的值
        if (value === 'true') {
          result[key] = true;
        } else if (value === 'false') {
          result[key] = false;
        } else if (/^\d+$/.test(value)) {
          result[key] = parseInt(value, 10);
        } else if (/^\d+\.\d+$/.test(value)) {
          result[key] = parseFloat(value);
        } else if (value.startsWith('"') && value.endsWith('"')) {
          result[key] = value.slice(1, -1);
        } else if (value.startsWith("'") && value.endsWith("'")) {
          result[key] = value.slice(1, -1);
        } else {
          result[key] = value.trim();
        }
      }
    }
  }

  return result;
}

/** 解析 YAML 字符串（简化版） */
export function parseYAML(content: string): Record<string, unknown> {
  // 移除注释行
  const lines = content.split('\n').filter((line) => !line.trim().startsWith('#'));
  return parseSimpleYAML(lines.join('\n'));
}

// ════════════════════════════════════════════════════════════
// 工具定义解析
// ════════════════════════════════════════════════════════════

/** 解析工具 YAML 文件 */
export function parseToolYAML(yamlPath: string): ToolYAMLDefinition {
  if (!existsSync(yamlPath)) {
    throw new Error(`Tool YAML file not found: ${yamlPath}`);
  }

  const content = readFileSync(yamlPath, 'utf-8');
  return parseToolYAMLContent(content, yamlPath);
}

/** 解析工具 YAML 内容 */
export function parseToolYAMLContent(content: string, filePath?: string): ToolYAMLDefinition {
  // 提取 YAML 块（支持 --- 分隔符）
  let yamlContent = content;
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    yamlContent = frontmatterMatch[1]!;
  }

  // 解析基本字段
  const parsed = parseYAML(yamlContent);

  // 验证必填字段
  if (!parsed.name) {
    throw new Error(`Missing required field 'name' in tool definition${filePath ? ` (${filePath})` : ''}`);
  }
  if (!parsed.description) {
    throw new Error(`Missing required field 'description' in tool definition${filePath ? ` (${filePath})` : ''}`);
  }

  // 解析 input_schema（简化版，支持 JSON Schema）
  let inputSchema = {
    type: 'object' as const,
    properties: {} as Record<string, unknown>,
    required: [] as string[],
    additionalProperties: false,
  };

  // 从 YAML 中提取 properties 定义
  const propertiesMatch = yamlContent.match(/input_schema:\s*\n([\s\S]*?)(?=\n\w|\n$)/);
  if (propertiesMatch) {
    const schemaContent = propertiesMatch[1]!;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    // 解析 properties 块
    const propsMatch = schemaContent.match(/properties:\s*\n([\s\S]*?)(?=\n\s{2}\w|\n\s*\w|$)/);
    if (propsMatch) {
      const propsContent = propsMatch[1]!;
      const propBlocks = propsContent.split(/\n(?=\s{4}\w)/);

      for (const block of propBlocks) {
        const nameMatch = block.match(/^\s{4}(\w+):/);
        if (nameMatch) {
          const propName = nameMatch[1]!;
          const propDef: Record<string, unknown> = {};

          const typeMatch = block.match(/type:\s*(\w+)/);
          if (typeMatch) propDef.type = typeMatch[1];

          const descMatch = block.match(/description:\s*(.+)/);
          if (descMatch) propDef.description = descMatch[1]!.trim();

          const defaultMatch = block.match(/default:\s*(.+)/);
          if (defaultMatch) {
            const val = defaultMatch[1]!.trim();
            if (val === 'true') propDef.default = true;
            else if (val === 'false') propDef.default = false;
            else if (/^\d+$/.test(val)) propDef.default = parseInt(val, 10);
            else propDef.default = val;
          }

          properties[propName] = propDef;
        }
      }
    }

    // 解析 required 块
    const requiredMatch = schemaContent.match(/required:\s*\n([\s\S]*?)(?=\n\s{2}\w|\n\s*\w|$)/);
    if (requiredMatch) {
      const requiredContent = requiredMatch[1]!;
      const items = requiredContent.match(/-\s*(\w+)/g);
      if (items) {
        required.push(...items.map((item) => item.replace(/-\s*/, '')));
      }
    }

    inputSchema = {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  // 构建工具定义
  const definition: ToolYAMLDefinition = {
    type: 'tool',
    name: parsed.name as string,
    description: parsed.description as string,
    input_schema: inputSchema as ToolYAMLDefinition['input_schema'],
    defer_loading: parsed.defer_loading as boolean | undefined,
    search_hint: parsed.search_hint as string | undefined,
    formatter: parsed.formatter as string | undefined,
    extra_kwargs: parsed.extra_kwargs as Record<string, unknown> | undefined,
  };

  return definition;
}

// ════════════════════════════════════════════════════════════
// Skill 元数据解析
// ════════════════════════════════════════════════════════════

/** 解析 SKILL.md 文件 */
export function parseSkillMarkdown(skillMdPath: string): SkillMetadata {
  if (!existsSync(skillMdPath)) {
    throw new Error(`SKILL.md not found: ${skillMdPath}`);
  }

  const content = readFileSync(skillMdPath, 'utf-8');
  return parseSkillMarkdownContent(content, skillMdPath);
}

/** 解析 SKILL.md 内容 */
export function parseSkillMarkdownContent(content: string, filePath?: string): SkillMetadata {
  // 提取 frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    throw new Error(`Missing frontmatter in SKILL.md${filePath ? ` (${filePath})` : ''}`);
  }

  const yamlContent = frontmatterMatch[1]!;
  const parsed = parseYAML(yamlContent);

  // 验证必填字段
  if (!parsed.name) {
    throw new Error(`Missing required field 'name' in SKILL.md${filePath ? ` (${filePath})` : ''}`);
  }
  if (!parsed.version) {
    throw new Error(`Missing required field 'version' in SKILL.md${filePath ? ` (${filePath})` : ''}`);
  }
  if (!parsed.description) {
    throw new Error(`Missing required field 'description' in SKILL.md${filePath ? ` (${filePath})` : ''}`);
  }

  // 提取工具定义（从内容中解析）
  const tools = extractToolsFromContent(content);

  // 构建元数据
  const metadata: SkillMetadata = {
    name: parsed.name as string,
    version: parsed.version as string,
    description: parsed.description as string,
    author: parsed.author as string | undefined,
    permissions: (parsed.permissions as 'private' | 'team' | 'public') || 'private',
    tags: (parsed.tags as string[]) || [],
    tools,
    content,
  };

  return metadata;
}

/** 从内容中提取工具定义 */
function extractToolsFromContent(content: string): SkillToolMetadata[] {
  const tools: SkillToolMetadata[] = [];

  // 查找工具部分（## Tools 或 ## 工具）
  const toolSectionMatch = content.match(/##\s*(?:Tools?|工具)\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!toolSectionMatch) return tools;

  const toolSection = toolSectionMatch[1]!;

  // 查找所有工具定义（### 工具名）
  const toolBlocks = toolSection.split(/###\s+/);

  for (const block of toolBlocks) {
    if (!block.trim()) continue;

    const lines = block.split('\n');
    const nameLine = lines[0]?.trim();
    if (!nameLine) continue;

    // 提取工具名
    const name = nameLine.toLowerCase().replace(/\s+/g, '-');

    // 提取描述（第一行非空内容）
    const description = lines.slice(1).find((l) => l.trim())?.trim() || '';

    // 提取参数（简化版）
    const parameters: Record<string, unknown> = {
      type: 'object',
      properties: {},
      required: [],
    };

    // 查找参数部分
    const paramSection = block.match(/\*\*参数\*\*:\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
    if (paramSection) {
      const paramLines = paramSection[1]!.split('\n');
      for (const line of paramLines) {
        const paramMatch = line.match(/^-\s*`(\w+)`:\s*(.+)/);
        if (paramMatch) {
          const [, paramName, paramDesc] = paramMatch;
          (parameters.properties as Record<string, unknown>)[paramName!] = {
            type: 'string',
            description: paramDesc!.trim(),
          };
        }
      }
    }

    tools.push({
      name,
      description,
      parameters,
    });
  }

  return tools;
}

// ════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════

/** 解析环境变量引用 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, envVar) => {
    return process.env[envVar] || '';
  });
}

/** 合并 extra_kwargs */
export function mergeExtraKwargs(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  if (!extra) return base;

  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string' && value.startsWith('${')) {
      result[key] = resolveEnvVars(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
