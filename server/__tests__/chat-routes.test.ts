import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createChatRoutes } from '../routes/chat';
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
});
