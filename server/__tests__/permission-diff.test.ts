import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildToolDiff } from '../utils/tool-diff';
import { ClaudeAgentManager } from '../claude/agent-manager';

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  file = path.join(dir, 'code.ts');
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildToolDiff', () => {
  it('Edit：按 old/new string 构造应用后全文', () => {
    const d = buildToolDiff('Edit', {
      file_path: file,
      old_string: 'const a = 1;',
      new_string: 'const a = 42;',
    });
    expect(d!.newContent).toBe('const a = 42;\nconst b = 2;\n');
    expect(d!.diffLines.some(l => l.type === 'add' && l.text.includes('42'))).toBe(true);
    expect(d!.diffLines.some(l => l.type === 'del' && l.text.includes('= 1;'))).toBe(true);
  });

  it('Edit replace_all 替换全部出现', () => {
    const f2 = path.join(dir, 'all.ts');
    fs.writeFileSync(f2, 'x\nx\n');
    const d = buildToolDiff('Edit', { file_path: f2, old_string: 'x', new_string: 'y', replace_all: true });
    expect(d!.newContent).toBe('y\ny\n');
  });

  it('Write：整个文件替换', () => {
    const d = buildToolDiff('Write', { file_path: file, content: 'totally new' });
    expect(d!.oldContent).toContain(('const a = 42;' as string) === '' ? '' : 'const');
    expect(d!.newContent).toBe('totally new');
  });

  it('新文件（读不到原内容）全绿 add', () => {
    const d = buildToolDiff('Write', { file_path: path.join(dir, 'new.ts'), content: 'hi' });
    expect(d!.oldContent).toBe('');
    expect(d!.diffLines.every(l => l.type === 'add' || l.type === 'ctx')).toBe(true);
  });

  it('非编辑类工具返回 null', () => {
    expect(buildToolDiff('Bash', { command: 'ls' })).toBeNull();
  });
});

describe('canUseTool 附载 diff', () => {
  it('Edit 权限请求携带 diff 载荷', async () => {
    const sent: any[] = [];
    const wsChannel = { broadcastToSession: (_id: string, e: any) => sent.push(e) } as never;
    const manager = new ClaudeAgentManager();
    const hook = (manager as unknown as {
      createPermissionHook: (ws: never, sid: string) => (
        toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;
    }).createPermissionHook(wsChannel as never, 'sess-diff-1');

    const pending = hook('Edit', { file_path: file, old_string: 'const a = 42;', new_string: 'const a = 1;' }, {
      signal: new AbortController().signal, toolUseID: 't1',
    });

    const broadcastEvent = sent.find(e => e.type === 'permission_request');
    expect(broadcastEvent).toBeDefined();
    expect(broadcastEvent.data.diff).toBeDefined();
    expect(broadcastEvent.data.diff.path).toBe(file);
    expect(broadcastEvent.data.diff.diffLines.length).toBeGreaterThan(0);

    const { resolvePermission } = await import('../ws/permission-store');
    resolvePermission(broadcastEvent.data.id, 'deny');
    await pending;
  });
});
