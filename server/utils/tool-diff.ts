import fs from 'fs';
import { lineDiff } from './diff';
import type { DiffInfo } from '../../shared/types';

/**
 * 为 Edit/Write/NotebookEdit 构造"应用后全文"预览与行级 diff。
 * 读不到原文件（新建）按空字符串处理，diff 全为 add。
 */
export function buildToolDiff(toolName: string, input: Record<string, unknown>): DiffInfo | null {
  const p = (input.file_path || input.notebook_path) as string | undefined;
  if (!p) return null;

  let oldContent = '';
  try { oldContent = fs.readFileSync(p, 'utf-8'); } catch { oldContent = ''; }

  let newContent = oldContent;
  if (toolName === 'Edit') {
    const oldStr = input.old_string as string | undefined;
    const newStr = (input.new_string as string) ?? '';
    if (typeof oldStr === 'string' && oldStr.length > 0) {
      newContent = input.replace_all
        ? oldContent.split(oldStr).join(newStr)
        : oldContent.replace(oldStr, () => newStr);
    }
  } else if (toolName === 'Write') {
    newContent = (input.content as string) ?? '';
  } else if (toolName === 'NotebookEdit') {
    newContent = (input.new_source as string) ?? oldContent;
  } else {
    return null;
  }

  return { path: p, oldContent, newContent, diffLines: lineDiff(oldContent, newContent) };
}
