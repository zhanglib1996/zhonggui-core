// Skill Manifest 类型定义

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  requires: string[];
  conflicts: string[];
  parameters?: Record<string, unknown>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}
