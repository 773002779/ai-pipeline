import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { PipelineRepository } from '../db/repositories/pipelines';
import { createApp } from '../app';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Pipeline } from '../../shared/types';

// 验证真实 createApp 的接线：providerRepo 必须传入 session 路由，
// 否则启动/恢复时不会因为缺少生效供应商而被拦截（400）。
let db: SqlJsDatabase;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  const dbHelper = new DbHelper(db);

  const pipelineRepo = new PipelineRepository(dbHelper);
  const pipeline: Pipeline = {
    id: 'pipe-wiring',
    name: '接线测试流水线',
    description: '',
    steps: [{ id: 'ps1', templateId: 't1', order: 1 }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  pipelineRepo.create(pipeline);

  // 与 index.ts 相同的装配方式（省略 wsChannel/llmProxy，启动守卫先于 executor 触达）
  const app = createApp({ dbHelper });
  await new Promise<void>(r => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => {
  db.close();
  server.close();
});

describe('createApp wiring (real app)', () => {
  it('start returns 400 when no provider is active (providerRepo wired into session routes)', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipelineId: 'pipe-wiring',
        name: '接线测试',
        requirement: '需求描述',
        workspaces: [{ name: 'backend', path: 'D:/tmp/proj', type: 'backend' }],
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: session } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/start`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('供应商');
  });
});
