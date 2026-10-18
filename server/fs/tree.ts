import fs from 'fs';
import path from 'path';
import type { FsNode } from '../../shared/types';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.pipeline', '.venv', 'venv',
]);

/** 递归列出目录树；忽略常见依赖/构建目录；深度与条目数设上限 */
export function listTree(root: string, maxDepth = 8, maxEntries = 2000): FsNode {
  let count = 0;
  const walk = (dir: string, depth: number): FsNode => {
    const node: FsNode = { name: path.basename(dir) || dir, path: dir, type: 'dir', children: [] };
    if (depth >= maxDepth || count >= maxEntries) return node;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return node; // 无权限等：按空目录处理
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    );
    for (const e of entries) {
      if (count >= maxEntries) break;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) node.children!.push(walk(full, depth + 1));
      else node.children!.push({ name: e.name, path: full, type: 'file' });
    }
    return node;
  };
  return walk(root, 0);
}
