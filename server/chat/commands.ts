/** / 命令解析（服务端分发）。非命令返回 null；空 token（"/"、"/ clear"）视为非命令。 */
export type ChatCommand =
  | { type: 'clear' }
  | { type: 'compact' }
  | { type: 'skill'; name: string };

export function parseChatCommand(content: string): ChatCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.slice(1).split(/\s/, 1)[0];
  if (!token) return null;
  if (token === 'clear') return { type: 'clear' };
  if (token === 'compact') return { type: 'compact' };
  return { type: 'skill', name: token };
}

/** /compact 隐藏摘要轮的固定指令 */
export function buildCompactPrompt(): string {
  return [
    '请将我们此前的对话压缩成一份结构化摘要，供后续对话作为唯一上下文使用。',
    '摘要需包含：1) 任务目标与背景；2) 已做出的关键决定与结论；3) 未完成事项与下一步；4) 后续对话所需的关键上下文（文件路径、约定、约束等）。',
    '只输出摘要正文，不要额外解释。',
  ].join('\n');
}

/** skill 命令注入的 prompt 块（与 @引用的 Referenced Files 块并列，置于 prompt 末尾） */
export function buildSkillBlock(skill?: { name: string; prompt: string }): string {
  if (!skill) return '';
  return [`## Skill: ${skill.name}`, skill.prompt].join('\n\n');
}
