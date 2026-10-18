import { describe, it, expect } from 'vitest';
import { parseChatCommand, buildCompactPrompt, buildSkillBlock } from '../chat/commands';

describe('parseChatCommand', () => {
  it('识别 /clear 与 /compact（忽略大小写不必要，精确匹配）', () => {
    expect(parseChatCommand('/clear')).toEqual({ type: 'clear' });
    expect(parseChatCommand('/clear 现在')).toEqual({ type: 'clear' });
    expect(parseChatCommand('  /compact  ')).toEqual({ type: 'compact' });
  });

  it('非命令返回 null', () => {
    expect(parseChatCommand('你好')).toBeNull();
    expect(parseChatCommand('看看 /clear 这个词')).toBeNull(); // 不以 / 开头
  });

  it('/ 与 "/ 空格" 视为非命令', () => {
    expect(parseChatCommand('/')).toBeNull();
    expect(parseChatCommand('/ clear')).toBeNull();
  });

  it('其余 /token 解析为 skill 命令', () => {
    expect(parseChatCommand('/code-review 帮我审查')).toEqual({ type: 'skill', name: 'code-review' });
    expect(parseChatCommand('/代码审查')).toEqual({ type: 'skill', name: '代码审查' });
  });
});

describe('buildCompactPrompt', () => {
  it('包含摘要指令的结构化要求', () => {
    const p = buildCompactPrompt();
    expect(p).toContain('摘要');
    expect(p).toContain('未完成事项');
    expect(p).toContain('只输出摘要正文');
  });
});

describe('buildSkillBlock', () => {
  it('无 skill 返回空串', () => {
    expect(buildSkillBlock(undefined)).toBe('');
  });

  it('生成 Skill 注入块', () => {
    const block = buildSkillBlock({ name: 'code-review', prompt: '审查代码时…' });
    expect(block).toBe('## Skill: code-review\n\n审查代码时…');
  });
});
