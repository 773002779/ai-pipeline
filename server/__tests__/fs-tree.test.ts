import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listTree } from '../fs/tree';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'r');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('listTree', () => {
  it('递归列出文件与目录', () => {
    const tree = listTree(root);
    expect(tree.type).toBe('dir');
    const names = (tree.children || []).map(c => c.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    const src = (tree.children || []).find(c => c.name === 'src');
    expect(src!.children!.map(c => c.name)).toContain('a.ts');
  });

  it('忽略 node_modules/.git/dist 等目录', () => {
    const names = (listTree(root).children || []).map(c => c.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('maxDepth 限制递归深度', () => {
    fs.mkdirSync(path.join(root, 'd1', 'd2', 'd3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'd1', 'd2', 'd3', 'deep.ts'), 'x');
    const tree = listTree(root, 2);
    const d1 = (tree.children || []).find(c => c.name === 'd1');
    const d2 = (d1!.children || []).find(c => c.name === 'd2');
    // depth=2 时 d2 的子层不再展开
    expect((d2!.children || []).find(c => c.name === 'd3')?.children).toBeUndefined();
  });
});
