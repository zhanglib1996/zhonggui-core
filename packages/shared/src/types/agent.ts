// Agent 相关类型定义

export interface SandboxPolicy {
  file: {
    allowed: string[];
    readonly: string[];
    denied: string[];
  };
  network: {
    mode: 'open' | 'restricted';
    allowedHosts?: string[];
  };
  shell: {
    mode: 'disabled' | 'safe';
    allowedCommands?: string[];
  };
  database: {
    mode: 'disabled' | 'readonly' | 'readwrite';
    allowedTables?: string[];
    dsn?: string;
  };
}

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  llmConfigId?: string;
  systemPrompt: string;
  maxToolCalls: number;
  maxConversationTurns: number;
  maxContextTokens: number;
  maxToolConcurrency: number;
  overrideModel?: string;
  sandboxPolicy: SandboxPolicy;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
