/**
 * ToolRegistry 实现
 * 管理内置工具、Skill 工具、MCP 工具的统一注册中心
 */

import type { ToolRegistry, AgentTool } from './index.js';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, AgentTool>();

  return {
    register(tool) {
      if (tools.has(tool.name)) {
        console.warn(`Tool "${tool.name}" already registered, overwriting`);
      }
      tools.set(tool.name, tool);
    },

    get(name) {
      return tools.get(name);
    },

    list() {
      return Array.from(tools.values());
    },
  };
}
