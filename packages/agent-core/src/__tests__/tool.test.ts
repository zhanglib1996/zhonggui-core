import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Tool, ToolCollection } from '../tool.js';
import { parseToolYAMLContent } from '../yaml-parser.js';

describe('Tool', () => {
  const sampleYAML = `
type: tool
name: calculator
description: 计算数学表达式
input_schema:
  type: object
  properties:
    expression:
      type: string
      description: 数学表达式
  required:
    - expression
  additionalProperties: false
`;

  it('should create tool from YAML content', () => {
    const binding = async (args: Record<string, unknown>) => {
      return { result: eval(args.expression as string) };
    };

    const tool = Tool.fromYAMLContent(sampleYAML, binding);
    expect(tool.definition.name).toBe('calculator');
    expect(tool.definition.description).toBe('计算数学表达式');
  });

  it('should convert to AgentTool', () => {
    const binding = async (args: Record<string, unknown>) => {
      return { result: 42 };
    };

    const tool = Tool.fromYAMLContent(sampleYAML, binding);
    const agentTool = tool.toAgentTool();

    expect(agentTool.name).toBe('calculator');
    expect(agentTool.description).toBe('计算数学表达式');
    expect(agentTool.parameters).toBeDefined();
    expect(typeof agentTool.execute).toBe('function');
  });

  it('should check deferred loading', () => {
    const deferredYAML = `
type: tool
name: slack_send
description: 发送 Slack 消息
defer_loading: true
search_hint: slack chat
input_schema:
  type: object
  properties: {}
`;

    const binding = async () => ({});
    const tool = Tool.fromYAMLContent(deferredYAML, binding);

    expect(tool.isDeferred()).toBe(true);
    expect(tool.getSearchHint()).toBe('slack chat');
  });

  it('should create tool with Tool.create()', () => {
    const binding = async () => ({});
    const tool = Tool.create(
      {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { input: { type: 'string' } },
      },
      binding,
    );

    expect(tool.definition.name).toBe('test_tool');
    expect(tool.definition.deferLoading).toBe(false);
  });
});

describe('ToolCollection', () => {
  it('should manage tools', () => {
    const collection = new ToolCollection();
    const binding = async () => ({});

    const tool1 = Tool.create({ name: 'tool1', description: 'Tool 1', parameters: {} }, binding);
    const tool2 = Tool.create({ name: 'tool2', description: 'Tool 2', parameters: {} }, binding);

    collection.add(tool1);
    collection.add(tool2);

    expect(collection.all()).toHaveLength(2);
    expect(collection.get('tool1')).toBeDefined();
    expect(collection.get('tool2')).toBeDefined();
  });

  it('should filter eager and deferred tools', () => {
    const collection = new ToolCollection();
    const binding = async () => ({});

    const eager = Tool.create({ name: 'eager', description: 'Eager', parameters: {} }, binding);
    const deferred = Tool.create(
      { name: 'deferred', description: 'Deferred', parameters: {}, deferLoading: true },
      binding,
    );

    collection.add(eager);
    collection.add(deferred);

    expect(collection.eager()).toHaveLength(1);
    expect(collection.deferred()).toHaveLength(1);
  });

  it('should search tools', () => {
    const collection = new ToolCollection();
    const binding = async () => ({});

    const webSearch = Tool.create(
      { name: 'web_search', description: 'Search the web', parameters: {} },
      binding,
    );
    const fileRead = Tool.create(
      { name: 'read_file', description: 'Read a file', parameters: {} },
      binding,
    );

    collection.add(webSearch);
    collection.add(fileRead);

    const results = collection.search('web');
    expect(results).toHaveLength(1);
    expect(results[0]?.definition.name).toBe('web_search');
  });
});

describe('parseToolYAMLContent', () => {
  it('should parse tool YAML', () => {
    const yaml = `
name: test_tool
description: A test tool for testing
`;
    const result = parseToolYAMLContent(yaml);
    expect(result.name).toBe('test_tool');
    expect(result.description).toBe('A test tool for testing');
  });

  it('should throw on missing name', () => {
    const yaml = `
description: A tool without name
`;
    expect(() => parseToolYAMLContent(yaml)).toThrow('Missing required field');
  });
});
