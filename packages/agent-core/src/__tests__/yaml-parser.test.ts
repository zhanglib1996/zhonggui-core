import { describe, it, expect, vi } from 'vitest';
import {
  parseYAML,
  parseToolYAMLContent,
  parseSkillMarkdownContent,
  resolveEnvVars,
  mergeExtraKwargs,
} from '../yaml-parser.js';

describe('parseYAML', () => {
  it('should parse simple key-value pairs', () => {
    const result = parseYAML('name: test\ndescription: hello\n');
    expect(result.name).toBe('test');
    expect(result.description).toBe('hello');
  });

  it('should parse boolean values', () => {
    const result = parseYAML('enabled: true\ndisabled: false\n');
    expect(result.enabled).toBe(true);
    expect(result.disabled).toBe(false);
  });

  it('should parse integer values', () => {
    const result = parseYAML('count: 42\n');
    expect(result.count).toBe(42);
  });

  it('should parse float values', () => {
    const result = parseYAML('rate: 3.14\n');
    expect(result.rate).toBe(3.14);
  });

  it('should parse quoted strings', () => {
    const result = parseYAML('name: "hello world"\ntitle: \'test\'\n');
    expect(result.name).toBe('hello world');
    expect(result.title).toBe('test');
  });

  it('should skip comments', () => {
    const result = parseYAML('# comment\nname: test\n# another comment\n');
    expect(result.name).toBe('test');
    expect(Object.keys(result)).toHaveLength(1);
  });
});

describe('parseToolYAMLContent', () => {
  const validYAML = `
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

  it('should parse valid tool YAML', () => {
    const tool = parseToolYAMLContent(validYAML);
    expect(tool.type).toBe('tool');
    expect(tool.name).toBe('calculator');
    expect(tool.description).toBe('计算数学表达式');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.properties.expression).toBeDefined();
  });

  it('should parse frontmatter wrapped YAML', () => {
    const content = `---\n${validYAML}\n---`;
    const tool = parseToolYAMLContent(content);
    expect(tool.name).toBe('calculator');
  });

  it('should throw on missing name', () => {
    expect(() => parseToolYAMLContent('description: test\n')).toThrow('Missing required field \'name\'');
  });

  it('should throw on missing description', () => {
    expect(() => parseToolYAMLContent('name: test\n')).toThrow('Missing required field \'description\'');
  });

  it('should parse optional fields', () => {
    const yaml = `
type: tool
name: search
description: 搜索工具
defer_loading: true
search_hint: 搜索网页
formatter: markdown
`;
    const tool = parseToolYAMLContent(yaml);
    expect(tool.defer_loading).toBe(true);
    expect(tool.search_hint).toBe('搜索网页');
    expect(tool.formatter).toBe('markdown');
  });
});

describe('parseSkillMarkdownContent', () => {
  const validSkill = `---
name: planning-analysis
version: "1.0.0"
description: 城市规划分析工具集
author: test
permissions: team
---

# 规划分析

这是一个城市规划分析技能。

## Tools

### analyze-traffic
交通流量分析

**参数**:
- \`region\`: 分析区域
- \`timeRange\`: 时间范围
`;

  it('should parse valid SKILL.md', () => {
    const skill = parseSkillMarkdownContent(validSkill);
    expect(skill.name).toBe('planning-analysis');
    expect(skill.version).toBe('1.0.0');
    expect(skill.description).toBe('城市规划分析工具集');
    expect(skill.author).toBe('test');
    expect(skill.permissions).toBe('team');
    expect(Array.isArray(skill.tags)).toBe(true);
  });

  it('should extract tools from content', () => {
    const skill = parseSkillMarkdownContent(validSkill);
    expect(skill.tools.length).toBeGreaterThan(0);
    expect(skill.tools[0].name).toBe('analyze-traffic');
  });

  it('should throw on missing frontmatter', () => {
    expect(() => parseSkillMarkdownContent('# No frontmatter\n')).toThrow('Missing frontmatter');
  });

  it('should throw on missing name', () => {
    expect(() => parseSkillMarkdownContent('---\nversion: 1.0.0\ndescription: test\n---\n')).toThrow('Missing required field \'name\'');
  });

  it('should throw on missing version', () => {
    expect(() => parseSkillMarkdownContent('---\nname: test\ndescription: test\n---\n')).toThrow('Missing required field \'version\'');
  });
});

describe('resolveEnvVars', () => {
  it('should resolve environment variables', () => {
    process.env.TEST_VAR = 'hello';
    expect(resolveEnvVars('${TEST_VAR}')).toBe('hello');
    delete process.env.TEST_VAR;
  });

  it('should return empty string for missing env vars', () => {
    expect(resolveEnvVars('${NONEXISTENT_VAR}')).toBe('');
  });

  it('should resolve multiple env vars', () => {
    process.env.A = 'hello';
    process.env.B = 'world';
    expect(resolveEnvVars('${A} ${B}')).toBe('hello world');
    delete process.env.A;
    delete process.env.B;
  });
});

describe('mergeExtraKwargs', () => {
  it('should merge extra kwargs into base', () => {
    const result = mergeExtraKwargs({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('should return base when no extra', () => {
    const result = mergeExtraKwargs({ a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it('should resolve env vars in extra values', () => {
    process.env.API_KEY = 'secret';
    const result = mergeExtraKwargs({}, { key: '${API_KEY}' });
    expect(result.key).toBe('secret');
    delete process.env.API_KEY;
  });

  it('should override base values with extra', () => {
    const result = mergeExtraKwargs({ a: 1 }, { a: 2 });
    expect(result.a).toBe(2);
  });
});
