import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMentions, buildReferencedFilesBlock } from '../chat/mentions';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'b');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('parseMentions', () => {
  it('解析存在的文件为绝对路径并去重', () => {
    const r = parseMentions('看一下 @a.ts 和 @src/b.ts，再看看 @a.ts', root);
    expect(r.files).toEqual([path.join(root, 'a.ts'), path.join(root, 'src', 'b.ts')]);
  });

  it('拒绝 ../ 路径逃逸', () => {
    const r = parseMentions('@../outside.txt', root);
    expect(r.files).toHaveLength(0);
    expect(r.invalid).toContain('../outside.txt');
  });

  it('不存在的引用进入 missing', () => {
    const r = parseMentions('@not-exist.ts', root);
    expect(r.files).toHaveLength(0);
    expect(r.missing).toContain('not-exist.ts');
  });

  it('目录引用不算命中', () => {
    const r = parseMentions('@src', root);
    expect(r.files).toHaveLength(0);
    expect(r.missing).toContain('src');
  });
});

describe('buildReferencedFilesBlock', () => {
  it('空列表返回空串', () => {
    expect(buildReferencedFilesBlock([])).toBe('');
  });

  it('生成引用块', () => {
    const block = buildReferencedFilesBlock(['/x/a.ts']);
    expect(block).toContain('## Referenced Files');
    expect(block).toContain('- /x/a.ts');
  });
});
