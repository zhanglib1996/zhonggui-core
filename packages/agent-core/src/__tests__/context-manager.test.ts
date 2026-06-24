import { describe, it, expect } from 'vitest';
import { DefaultContextManager, estimateTokens, countMessageTokens } from '../context-manager.js';
import type { ChatMessage } from '../index.js';

describe('estimateTokens', () => {
  it('should estimate Chinese characters', () => {
    const tokens = estimateTokens('你好世界');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(4);
  });

  it('should estimate English characters', () => {
    const tokens = estimateTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(6);
  });

  it('should handle mixed content', () => {
    const tokens = estimateTokens('hello 你好 world 世界');
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('countMessageTokens', () => {
  it('should count tokens for simple message', () => {
    const message: ChatMessage = {
      id: '1',
      role: 'user',
      content: 'hello',
      timestamp: new Date(),
    };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should count tokens for message with tool calls', () => {
    const message: ChatMessage = {
      id: '1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'test_tool',
          arguments: { arg1: 'value1' },
        },
      ],
      timestamp: new Date(),
    };
    const tokens = countMessageTokens(message);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('DefaultContextManager', () => {
  const manager = new DefaultContextManager();

  const createMessages = (count: number): ChatMessage[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `msg_${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      timestamp: new Date(),
    })) as ChatMessage[];
  };

  it('should count tokens for messages', () => {
    const messages = createMessages(5);
    const tokens = manager.countTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should check if compaction is needed', () => {
    const messages = createMessages(100);
    const totalTokens = manager.countTokens(messages);
    expect(manager.needsCompaction(messages, totalTokens - 1)).toBe(true);
    expect(manager.needsCompaction(messages, totalTokens + 1000)).toBe(false);
  });

  it('should compact context by sliding window', () => {
    const messages = createMessages(100);
    const compacted = manager.compactContext(messages, 500);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(manager.countTokens(compacted)).toBeLessThanOrEqual(500);
  });

  it('should get context stats', () => {
    const messages = createMessages(10);
    const stats = manager.getContextStats(messages);
    expect(stats.messageCount).toBe(10);
    expect(stats.totalTokens).toBeGreaterThan(0);
    expect(stats.userMessages).toBe(5);
    expect(stats.assistantMessages).toBe(5);
  });
});
