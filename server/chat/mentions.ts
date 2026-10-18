import fs from 'fs';
import path from 'path';

export interface MentionResolution {
  files: string[];    // 解析成功的绝对路径（去重、保序）
  invalid: string[];  // 越界/非法引用（拒绝）
  missing: string[];  // 不存在或不是文件的引用（忽略）
}

// 提及符在空白或常见中文标点处终止（中文用户常在文件名后直接跟标点，如 “@a.ts，看一下”）
const MENTION_RE = /(^|\s)@([^\s@，。、；：！？]+)/g;

/** 解析消息中的 @path 引用；强制解析结果位于 root 内（防路径逃逸） */
export function parseMentions(content: string, root: string): MentionResolution {
  const files: string[] = [];
  const invalid: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const normalizedRoot = path.resolve(root);

  for (const match of content.matchAll(MENTION_RE)) {
    const rel = match[2];
    const abs = path.resolve(normalizedRoot, rel);
    if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
      if (!invalid.includes(rel)) invalid.push(rel);
      continue;
    }
    let isFile = false;
    try { isFile = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch { isFile = false; }
    if (!isFile) {
      if (!missing.includes(rel)) missing.push(rel);
      continue;
    }
    if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  }
  return { files, invalid, missing };
}

/** 生成提示 Claude 先读取引用文件的 prompt 块 */
export function buildReferencedFilesBlock(files: string[]): string {
  if (files.length === 0) return '';
  return ['## Referenced Files', 'Please read these files first:', ...files.map(f => `- ${f}`)].join('\n');
}
