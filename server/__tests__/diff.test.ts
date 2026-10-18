import { describe, it, expect } from 'vitest';
import { lineDiff } from '../utils/diff';

describe('lineDiff', () => {
  it('相同内容全 ctx', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'ctx', text: 'a' }, { type: 'ctx', text: 'b' },
    ]);
  });

  it('标记新增与删除行', () => {
    const d = lineDiff('a\nb\nc', 'a\nX\nc');
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'X' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('全新文件全 add', () => {
    expect(lineDiff('', 'l1\nl2')).toEqual([
      { type: 'add', text: 'l1' }, { type: 'add', text: 'l2' },
    ]);
  });

  it('超大文件回退为整删整加', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(big, big + '\nextra');
    // 3000 del + 3001 add = 6001 行，且包含 extra
    expect(d.filter(x => x.type === 'add').map(x => x.text)).toContain('extra');
  });
});
