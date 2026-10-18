import { describe, it, expect, beforeAll } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Session } from '../../shared/types';

let dbHelper: DbHelper;
let repo: SessionRepository;

function chatSession(id: string): Session {
  return {
    id, pipelineId: BUILTIN_CHAT_PIPELINE_ID,
    pipelineSnapshot: { id: BUILTIN_CHAT_PIPELINE_ID, name: '自由对话', description: '', steps: [], createdAt: '', updatedAt: '' },
    name: '新对话', requirement: '', status: 'idle',
    workspaces: [{ name: 'ws', path: 'D:/tmp', type: 'unknown' }],
    currentStepIndex: 0, steps: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  // 注：fixture 未建 pipelines 父行（sessions.pipeline_id 有外键），种子期间临时关闭外键校验
  db.run('PRAGMA foreign_keys = OFF');
  dbHelper = new DbHelper(db);
  repo = new SessionRepository(dbHelper);
});

describe('chat 会话仓库扩展', () => {
  it('create 持久化 chat 字段并回读', () => {
    const s = chatSession('c1');
    s.chatModel = 'deepseek-chat';
    repo.create(s);
    const loaded = repo.getById('c1');
    expect(loaded!.chatModel).toBe('deepseek-chat');
    expect(loaded!.chatSdkSessionId).toBeUndefined();
  });

  it('updateChatFields 更新模型与 sdk 会话句柄', () => {
    repo.create(chatSession('c2'));
    repo.updateChatFields('c2', { chatSdkSessionId: 'sdk-abc' });
    repo.updateChatFields('c2', { chatModel: 'gpt-4o' });
    const loaded = repo.getById('c2');
    expect(loaded!.chatSdkSessionId).toBe('sdk-abc');
    expect(loaded!.chatModel).toBe('gpt-4o');
  });

  it('listByPipeline 只返回指定流水线的会话', () => {
    repo.create(chatSession('c3'));
    const list = repo.listByPipeline(BUILTIN_CHAT_PIPELINE_ID);
    expect(list.map(s => s.id)).toContain('c3');
    // 不含非 chat 会话
    expect(list.every(s => s.pipelineId === BUILTIN_CHAT_PIPELINE_ID)).toBe(true);
  });

  it('deleteCascade 级联删除消息等关联数据', () => {
    repo.create(chatSession('c4'));
    repo.addMessage('c4', null, 'user', 'hello');
    dbHelper.run(`INSERT INTO usage_records (id, session_id, model) VALUES ('u-c4', 'c4', 'm')`);
    expect(repo.deleteCascade('c4')).toBe(true);
    expect(repo.getById('c4')).toBeNull();
    expect(dbHelper.get("SELECT * FROM messages WHERE session_id = 'c4'")).toBeUndefined();
    expect(dbHelper.get("SELECT * FROM usage_records WHERE session_id = 'c4'")).toBeUndefined();
    expect(repo.deleteCascade('c4')).toBe(false);
  });
});

describe('ensureBuiltinChatPipeline', () => {
  it('首次创建，幂等返回同一条', () => {
    const p1 = ensureBuiltinChatPipeline(dbHelper);
    expect(p1.id).toBe(BUILTIN_CHAT_PIPELINE_ID);
    expect(p1.name).toBe('自由对话');
    expect(p1.steps).toHaveLength(0);
    const p2 = ensureBuiltinChatPipeline(dbHelper);
    expect(p2.id).toBe(p1.id);
    // 不会重复插入
    const all = dbHelper.all<Record<string, unknown>>(
      `SELECT id FROM pipelines WHERE id = '${BUILTIN_CHAT_PIPELINE_ID}'`,
    );
    expect(all).toHaveLength(1);
  });
});

describe('chatSummary 与 resetChatContext', () => {
  it('updateChatFields 持久化 chatSummary；resetChatContext 清空句柄与摘要但保留模型', () => {
    repo.create(chatSession('c5'));
    repo.updateChatFields('c5', { chatSdkSessionId: 'sdk-1', chatModel: 'gpt-4o', chatSummary: '早期摘要' });
    expect(repo.getById('c5')!.chatSummary).toBe('早期摘要');

    repo.resetChatContext('c5');
    const loaded = repo.getById('c5')!;
    expect(loaded.chatSdkSessionId).toBeUndefined();
    expect(loaded.chatSummary).toBeUndefined();
    expect(loaded.chatModel).toBe('gpt-4o');
  });
});
