/**
 * ModelRouter 实现
 * 从环境变量读取模型配置，支持简单路由和降级
 *
 * 接口来自 @zhonggui/agent-core:
 *   selectModel(userMessage, userId) → ModelTarget
 *   degrade(currentModel) → ModelTarget
 */

import type { ModelRouter, ModelTarget } from '@zhonggui/agent-core';

// ─── 工厂函数 ───

export interface ModelRouterOptions {
  /** 默认模型配置（fallback） */
  defaultModel?: ModelTarget;
  /** 备用模型列表（降级链） */
  fallbackModels?: ModelTarget[];
}

export function createModelRouter(options?: ModelRouterOptions): ModelRouter {
  // 从环境变量构建默认模型
  const defaultModel: ModelTarget = options?.defaultModel ?? {
    provider: process.env.MODEL_PROVIDER ?? 'openai',
    model: process.env.MODEL_NAME ?? 'gpt-4o-mini',
    apiKey: process.env.MODEL_API_KEY,
    baseURL: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
  };

  // 降级链：默认模型 → 备用模型 → 硬编码 fallback
  const fallbackChain: ModelTarget[] = options?.fallbackModels ?? [
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: process.env.MODEL_API_KEY,
      baseURL: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1',
    },
  ];

  // 已知模型到 provider 的映射（用于自动检测）
  const providerHints: Record<string, string> = {
    'gpt': 'openai',
    'claude': 'anthropic',
    'qwen': 'dashscope',
    'deepseek': 'deepseek',
    'glm': 'zhipu',
  };

  function detectProvider(modelName: string): string {
    const lower = modelName.toLowerCase();
    for (const [hint, provider] of Object.entries(providerHints)) {
      if (lower.includes(hint)) return provider;
    }
    return 'openai';
  }

  return {
    selectModel(userMessage: string, _userId: string): ModelTarget {
      // 当前实现：始终返回默认模型
      // 未来可以扩展为：按用户消息内容/长度/复杂度路由到不同模型
      // 例如：短问题用小模型，长代码任务用大模型
      return { ...defaultModel };
    },

    degrade(currentModel: string): ModelTarget {
      // 在降级链中找到当前模型之后的下一个
      const currentIndex = fallbackChain.findIndex((m) => m.model === currentModel);

      if (currentIndex >= 0 && currentIndex < fallbackChain.length - 1) {
        const next = fallbackChain[currentIndex + 1]!;
        console.log(`[ModelRouter] Degrading from ${currentModel} to ${next.model}`);
        return { ...next };
      }

      // 如果当前模型不在链中，返回链的第一个
      if (fallbackChain.length > 0) {
        const first = fallbackChain[0]!;
        console.log(`[ModelRouter] Degrading from ${currentModel} to fallback ${first.model}`);
        return { ...first };
      }

      // 最终 fallback
      console.log(`[ModelRouter] No fallback available, returning default ${defaultModel.model}`);
      return { ...defaultModel };
    },
  };
}
