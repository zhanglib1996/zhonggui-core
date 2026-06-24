/**
 * 上下文管理器 — 参考 NexAU 的 Context Compaction 设计
 *
 * 职责：
 * - Token 计数（估算或精确）
 * - 上下文压缩（滑动窗口、摘要）
 * - 上下文裁剪（移除不重要的消息）
 */

import type { ChatMessage } from './index.js';

// ════════════════════════════════════════════════════════════
// 接口定义
// ════════════════════════════════════════════════════════════

export interface ContextManager {
  /** 计算消息 Token 数 */
  countTokens(messages: ChatMessage[]): number;

  /** 压缩上下文到指定 Token 数 */
  compactContext(messages: ChatMessage[], maxTokens: number): ChatMessage[];

  /** 检查是否需要压缩 */
  needsCompaction(messages: ChatMessage[], maxTokens: number): boolean;

  /** 获取上下文统计信息 */
  getContextStats(messages: ChatMessage[]): ContextStats;
}

export interface ContextStats {
  messageCount: number;
  totalTokens: number;
  userMessages: number;
  assistantMessages: number;
  toolMessages: number;
  averageTokensPerMessage: number;
}

// ════════════════════════════════════════════════════════════
// Token 计数策略
// ════════════════════════════════════════════════════════════

/** 简单估算（中文约 2 字符/token，英文约 4 字符/token） */
export function estimateTokens(text: string): number {
  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  // 统计非中文字符数
  const otherChars = text.length - chineseChars;
  // 估算 token 数
  return Math.ceil(chineseChars / 2 + otherChars / 4);
}

/** 基于消息内容计算 Token */
export function countMessageTokens(message: ChatMessage): number {
  let tokens = 0;

  // 角色 token
  tokens += 4; // role + separator

  // 内容 token
  if (message.content) {
    tokens += estimateTokens(message.content);
  }

  // 工具调用 token
  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      tokens += estimateTokens(toolCall.name);
      tokens += estimateTokens(JSON.stringify(toolCall.arguments));
    }
  }

  // 工具调用 ID token
  if (message.toolCallId) {
    tokens += estimateTokens(message.toolCallId);
  }

  return tokens;
}

// ════════════════════════════════════════════════════════════
// 上下文管理器实现
// ════════════════════════════════════════════════════════════

export class DefaultContextManager implements ContextManager {
  private cache = new Map<string, number>();

  countTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.getMessageTokens(message);
    }
    return total;
  }

  compactContext(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    if (messages.length === 0) return messages;

    // 计算当前 token 数
    let currentTokens = this.countTokens(messages);

    // 如果不需要压缩，直接返回
    if (currentTokens <= maxTokens) {
      return messages;
    }

    // 策略 1: 保留系统消息和最近的消息
    const result = this.compactBySlidingWindow(messages, maxTokens);

    // 如果还不满足，使用更激进的策略
    if (this.countTokens(result) > maxTokens) {
      return this.compactByTruncation(result, maxTokens);
    }

    return result;
  }

  needsCompaction(messages: ChatMessage[], maxTokens: number): boolean {
    return this.countTokens(messages) > maxTokens;
  }

  getContextStats(messages: ChatMessage[]): ContextStats {
    let totalTokens = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolMessages = 0;

    for (const message of messages) {
      totalTokens += this.getMessageTokens(message);

      switch (message.role) {
        case 'user':
          userMessages++;
          break;
        case 'assistant':
          assistantMessages++;
          break;
        case 'tool':
          toolMessages++;
          break;
      }
    }

    return {
      messageCount: messages.length,
      totalTokens,
      userMessages,
      assistantMessages,
      toolMessages,
      averageTokensPerMessage: messages.length > 0 ? Math.round(totalTokens / messages.length) : 0,
    };
  }

  private getMessageTokens(message: ChatMessage): number {
    // 使用缓存
    const cacheKey = message.id;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const tokens = countMessageTokens(message);
    this.cache.set(cacheKey, tokens);
    return tokens;
  }

  /** 滑动窗口压缩：保留最近的消息 */
  private compactBySlidingWindow(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    const result: ChatMessage[] = [];
    let currentTokens = 0;

    // 从后往前遍历，保留最近的消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      const messageTokens = this.getMessageTokens(message);

      if (currentTokens + messageTokens > maxTokens) {
        // 如果是第一条消息就超限，尝试截断
        if (result.length === 0) {
          const truncated = this.truncateMessage(message, maxTokens);
          if (truncated) {
            result.unshift(truncated);
          }
        }
        break;
      }

      result.unshift(message);
      currentTokens += messageTokens;
    }

    return result;
  }

  /** 截断压缩：移除中间的消息 */
  private compactByTruncation(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
    if (messages.length <= 2) {
      // 只有 1-2 条消息，尝试截断
      return messages.map((m) => this.truncateMessage(m, maxTokens / messages.length) || m);
    }

    // 保留第一条和最后一条，移除中间的消息
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const firstTokens = this.getMessageTokens(first);
    const lastTokens = this.getMessageTokens(last);

    if (firstTokens + lastTokens > maxTokens) {
      // 两条消息就超限，截断最后一条
      const truncated = this.truncateMessage(last, maxTokens - firstTokens);
      return truncated ? [first, truncated] : [first];
    }

    // 添加摘要消息
    const removedCount = messages.length - 2;
    const summaryMessage: ChatMessage = {
      id: `summary_${Date.now()}`,
      role: 'system',
      content: `[已省略 ${removedCount} 条历史消息]`,
      timestamp: new Date(),
    };

    const remainingTokens = maxTokens - firstTokens - lastTokens;
    const summaryTokens = this.getMessageTokens(summaryMessage);

    if (summaryTokens <= remainingTokens) {
      return [first, summaryMessage, last];
    }

    return [first, last];
  }

  /** 截断单条消息 */
  private truncateMessage(message: ChatMessage, maxTokens: number): ChatMessage | null {
    const messageTokens = this.getMessageTokens(message);

    if (messageTokens <= maxTokens) {
      return message;
    }

    // 计算可以保留的内容长度
    const contentTokens = estimateTokens(message.content);
    const otherTokens = messageTokens - contentTokens;
    const availableTokens = maxTokens - otherTokens;

    if (availableTokens <= 0) {
      return null;
    }

    // 截断内容（按比例）
    const ratio = availableTokens / contentTokens;
    const truncatedLength = Math.floor(message.content.length * ratio);
    const truncatedContent = message.content.slice(0, truncatedLength) + '...[已截断]';

    return {
      ...message,
      content: truncatedContent,
    };
  }

  /** 清除缓存 */
  clearCache(): void {
    this.cache.clear();
  }
}

// ════════════════════════════════════════════════════════════
// 工厂函数
// ════════════════════════════════════════════════════════════

export function createContextManager(): ContextManager {
  return new DefaultContextManager();
}
