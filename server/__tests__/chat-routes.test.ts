import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createChatRoutes } from '../routes/chat';
import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { ResourceRepository } from '../db/repositories/resources';
import { ChatTurnRunner } from '../chat/turn-runner';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';

let dbHelper: DbHelper;
let server: http.Server;
let baseUrl: string;

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  const app = express();
  app.use(express.json());
  app.use('/api/chat', createChatRoutes({ dbHelper }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('chat 会话 CRUD', () => {
  it('POST /sessions 创建对话（挂在内置流水线下）', async () => {
    const { status, body } = await req('POST', '/api/chat/sessions', {
      workspaces: [{ name: 'demo', path: 'D:/tmp', type: 'unknown' }],
      model: 'deepseek-chat',
    });
    expect(status).toBe(201);
    expect(body.data.pipelineId).toBe(BUILTIN_CHAT_PIPELINE_ID);
    expect(body.data.chatModel).toBe('deepseek-chat');
    expect(body.data.status).toBe('idle');
  });

  it('POST /sessions 无工作目录 400', async () => {
    const { status } = await req('POST', '/api/chat/sessions', { workspaces: [] });
    expect(status).toBe(400);
  });

  it('GET /sessions 只列对话会话', async () => {
    await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const { body } = await req('GET', '/api/chat/sessions');
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.data.every((s: any) => s.pipelineId === BUILTIN_CHAT_PIPELINE_ID)).toBe(true);
  });

  it('PUT /:id/model 更新会话级模型', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { body } = await req('PUT', `/api/chat/${id}/model`, { model: 'gpt-4o' });
    expect(body.data.chatModel).toBe('gpt-4o');
  });

  it('DELETE /:id 删除对话；流水线会话 id 404', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    expect((await req('DELETE', `/api/chat/${id}`)).status).toBe(200);
    expect((await req('GET', `/api/chat/sessions`)).body.data.every((s: any) => s.id !== id)).toBe(true);
  });

  it('PUT/DELETE 对非 chat 会话 404 且不删除数据', async () => {
    // 直接插入一条非 chat（pipeline）会话：fixture 未建 'some-pipeline' 父行，种子期间临时关闭外键校验
    const sessionRepo = new SessionRepository(dbHelper);
    dbHelper.raw().run('PRAGMA foreign_keys = OFF');
    sessionRepo.create({
      id: 'pipe-sess-1',
      pipelineId: 'some-pipeline',
      pipelineSnapshot: { id: 'some-pipeline', name: 'p', description: '', steps: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      name: '流水线会话',
      requirement: 'r',
      status: 'idle',
      workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }],
      currentStepIndex: 0,
      steps: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    dbHelper.raw().run('PRAGMA foreign_keys = ON');

    const put = await req('PUT', '/api/chat/pipe-sess-1/model', { model: 'gpt-4o' });
    expect(put.status).toBe(404);
    expect(put.body.error).toBe('对话不存在');

    const del = await req('DELETE', '/api/chat/pipe-sess-1');
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('对话不存在');

    // 守卫生效：会话未被级联删除
    expect(sessionRepo.getById('pipe-sess-1')).not.toBeNull();

    const missing = await req('PUT', '/api/chat/missing-id/model', { model: 'gpt-4o' });
    expect(missing.status).toBe(404);
  });
});

describe('chat messages/stop', () => {
  it('发消息 202；生成中再次发送 409；stop 后恢复', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: process.cwd(), type: 'unknown' }] });
    const id = created.body.data.id;

    // 挂起的伪 agentManager
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hangingRunner = new ChatTurnRunner({
      sessionRepo: new SessionRepository(dbHelper),
      usageRepo: new UsageRepository(dbHelper),
      agentManager: {
        async *executeChatTurn(cfg: any): AsyncGenerator<any> {
          yield { type: 'ai_stream', content: 'x', done: false };
          await gate;
          yield { type: 'ai_stream', content: '', done: true };
        },
      },
    });

    // 无生效供应商 → 400
    const blocked = await fetch(`${baseUrl}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(blocked.status).toBe(400);

    // 挂 providerRepo 依赖重新挂载一个带 runner 的实例（直接以第二个路由实例测 202/409/stop）
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: hangingRunner,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
    }));
    const server2 = http.createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const base2 = `http://127.0.0.1:${(server2.address() as any).port}`;

    const send = await fetch(`${base2}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(send.status).toBe(202);
    await new Promise(r => setTimeout(r, 30));

    const again = await fetch(`${base2}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'again' }),
    });
    expect(again.status).toBe(409);

    const stop = await fetch(`${base2}/api/chat/${id}/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    release();
    await new Promise(r => setTimeout(r, 30));
    server2.close();
  });

  it('流水线会话发消息 404', async () => {
    // 直接对不存在的 id
    const res = await fetch(`${baseUrl}/api/chat/missing-id/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('/clear：202 + 系统消息 + 清空会话句柄（无供应商也可用）', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }], model: 'm' });
    const id = created.body.data.id;
    const repo = new SessionRepository(dbHelper);
    // 直接种 SDK 会话句柄（绕过真实轮次）
    repo.updateChatFields(id, { chatSdkSessionId: 'sdk-x', chatSummary: '旧摘要' });
    // 上一轮可能以 error 收尾：/clear 应把 DB 状态持久化回 idle（仅广播不够）
    repo.updateStatus(id, 'error');

    const { status } = await req('POST', `/api/chat/${id}/messages`, { content: '/clear' });
    expect(status).toBe(202);

    const loaded = repo.getById(id)!;
    expect(loaded.status).toBe('idle');
    expect(loaded.chatSdkSessionId).toBeUndefined();
    expect(loaded.chatSummary).toBeUndefined();
    expect(loaded.chatModel).toBe('m'); // 模型选择保留
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'system'`,
    );
    expect(sysMsgs.some(m => String(m['content']).includes('上下文已清理'))).toBe(true);
    // 命令文本本身不入库
    const userMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'user'`,
    );
    expect(userMsgs).toHaveLength(0);
  });

  it('/compact：无 SDK 会话 → 202 + 「对话为空，无需压缩」', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { status } = await req('POST', `/api/chat/${id}/messages`, { content: '/compact' });
    expect(status).toBe(202);
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'system'`,
    );
    expect(sysMsgs.some(m => String(m['content']).includes('对话为空'))).toBe(true);
  });

  it('未知命令 400', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { status, body } = await req('POST', `/api/chat/${id}/messages`, { content: '/nope' });
    expect(status).toBe(400);
    expect(body.error).toContain('未知命令 /nope');
  });

  it('/clear：运行中 409', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    // 最小挂起 runner 触发运行态
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hanging = new ChatTurnRunner({
      sessionRepo: new SessionRepository(dbHelper), usageRepo: new UsageRepository(dbHelper),
      agentManager: { async *executeChatTurn(cfg: any): AsyncGenerator<any> {
        yield { type: 'ai_stream', content: 'x', done: false };
        await gate;
        yield { type: 'ai_stream', content: '', done: true };
      } },
    });
    const appX = express();
    appX.use(express.json());
    appX.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: hanging as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
    }));
    const serverX = http.createServer(appX);
    await new Promise<void>((resolve) => serverX.listen(0, resolve));
    const baseX = `http://127.0.0.1:${(serverX.address() as any).port}`;

    await fetch(`${baseX}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    await new Promise(r => setTimeout(r, 30));

    const cmd = await fetch(`${baseX}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/clear' }),
    });
    expect(cmd.status).toBe(409);

    release();
    await new Promise(r => setTimeout(r, 30));
    serverX.close();
  });

  it('/skill 命令：命中已启用 skill → 202 且 startTurn 收到 skill 参数', async () => {
    // 准备资源仓库 + 一个已启用 skill
    const resourceRepo = new ResourceRepository(dbHelper);
    resourceRepo.create({
      id: 'skill-cr', type: 'skill', name: 'code-review', description: '代码审查',
      version: '1.0.0', source: 'manual', config: { prompt: '审查代码时逐文件检查' },
      enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    const startTurnSpy = vi.fn();
    const spyRunner = { isRunning: () => false, startTurn: startTurnSpy, stop: () => false };
    const appY = express();
    appY.use(express.json());
    appY.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: spyRunner as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
      resourceRepo,
    }));
    const serverY = http.createServer(appY);
    await new Promise<void>((resolve) => serverY.listen(0, resolve));
    const baseY = `http://127.0.0.1:${(serverY.address() as any).port}`;

    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;

    const res = await fetch(`${baseY}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/code-review 重点看登录模块' }),
    });
    expect(res.status).toBe(202);
    expect(startTurnSpy).toHaveBeenCalledTimes(1);
    const [, content, , skill] = startTurnSpy.mock.calls[0];
    expect(content).toBe('/code-review 重点看登录模块');
    expect(skill).toEqual({ name: 'code-review', prompt: '审查代码时逐文件检查' });
    serverY.close();
  });

  it('/skill 命令：未命中（含禁用）→ 400 未知命令', async () => {
    const resourceRepo = new ResourceRepository(dbHelper);
    resourceRepo.create({
      id: 'skill-off', type: 'skill', name: 'disabled-skill', description: '',
      version: '1.0.0', source: 'manual', config: { prompt: 'x' },
      enabled: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    const spyRunner = { isRunning: () => false, startTurn: () => {}, stop: () => false };
    const appZ = express();
    appZ.use(express.json());
    appZ.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: spyRunner as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
      resourceRepo,
    }));
    const serverZ = http.createServer(appZ);
    await new Promise<void>((resolve) => serverZ.listen(0, resolve));
    const baseZ = `http://127.0.0.1:${(serverZ.address() as any).port}`;

    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;

    const res = await fetch(`${baseZ}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/disabled-skill' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('未知命令 /disabled-skill');
    serverZ.close();
  });
});
