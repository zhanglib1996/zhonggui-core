/**
 * SkillLoader 实现
 * 从文件系统加载 Skill（Markdown + YAML frontmatter / 纯 YAML 工具定义）
 *
 * 接口来自 @zhonggui/agent-core:
 *   load(userId) → AgentTool[]
 *   loadByName(userId, skillName) → AgentTool | null
 *
 * 使用 agent-core 的 parseToolYAMLContent / parseSkillMarkdownContent 解析
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { SkillLoader, AgentTool, SandboxProvider } from '@zhonggui/agent-core';
import { parseToolYAMLContent, parseSkillMarkdownContent } from '@zhonggui/agent-core';

// ─── 工厂函数 ───

export interface SkillLoaderOptions {
  /** Skill 文件目录，默认 ~/.zhonggui/skills */
  skillsDir?: string;
}

export function createSkillLoader(options?: SkillLoaderOptions): SkillLoader {
  const skillsDir = options?.skillsDir ?? join(process.env.HOME ?? '/tmp', '.zhonggui', 'skills');

  // 内存缓存：skillName → AgentTool[]
  const cache = new Map<string, AgentTool[]>();
  let cacheLoaded = false;

  async function ensureDir(): Promise<void> {
    if (!existsSync(skillsDir)) {
      // 目录不存在时创建（静默）
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(skillsDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  async function scanSkills(): Promise<Map<string, AgentTool[]>> {
    if (cacheLoaded) return cache;
    cacheLoaded = true;

    await ensureDir();

    try {
      const entries = await readdir(skillsDir);

      for (const entry of entries) {
        const fullPath = join(skillsDir, entry);
        const ext = extname(entry).toLowerCase();

        // 只处理 .yaml, .yml, .md 文件
        if (!['.yaml', '.yml', '.md'].includes(ext)) continue;

        try {
          const fileStat = await stat(fullPath);
          if (!fileStat.isFile()) continue;

          const content = await readFile(fullPath, 'utf-8');
          let tools: AgentTool[] = [];

          if (ext === '.md') {
            // Markdown Skill（frontmatter + body）
            const parsed = parseSkillMarkdownContent(content);
            if (parsed?.tools) {
              tools = parsed.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
                execute: async (_args: Record<string, unknown>, _sandbox: SandboxProvider) => {
                  // 默认执行器：返回提示信息
                  return { message: `Skill "${t.name}" loaded but no custom executor defined.` };
                },
              }));
            }
          } else {
            // YAML 工具定义
            const parsed = parseToolYAMLContent(content);
            if (parsed) {
              const definitions = Array.isArray(parsed) ? parsed : [parsed];
              tools = definitions.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.input_schema ?? { type: 'object', properties: {} },
                execute: async (_args: Record<string, unknown>, _sandbox: SandboxProvider) => {
                  return { message: `Tool "${t.name}" loaded but no custom executor defined.` };
                },
              }));
            }
          }

          if (tools.length > 0) {
            // 使用文件名（不含扩展名）作为 skill 名称
            const skillName = entry.replace(/\.(yaml|yml|md)$/i, '');
            cache.set(skillName, tools);
            console.log(`[SkillLoader] Loaded skill "${skillName}" with ${tools.length} tool(s)`);
          }
        } catch (err) {
          console.warn(`[SkillLoader] Failed to parse ${entry}:`, err);
        }
      }
    } catch (err) {
      console.warn(`[SkillLoader] Failed to scan skills dir:`, err);
    }

    return cache;
  }

  return {
    async load(userId: string): Promise<AgentTool[]> {
      const skills = await scanSkills();

      // 返回所有 skill 的工具（暂不按用户过滤，未来可扩展用户级 skill 配置）
      const allTools: AgentTool[] = [];
      for (const tools of skills.values()) {
        allTools.push(...tools);
      }

      return allTools;
    },

    async loadByName(userId: string, skillName: string): Promise<AgentTool | null> {
      const skills = await scanSkills();

      const tools = skills.get(skillName);
      if (!tools || tools.length === 0) return null;

      // 返回第一个工具（一个 skill 文件通常对应一个主工具）
      return tools[0] ?? null;
    },
  };
}
