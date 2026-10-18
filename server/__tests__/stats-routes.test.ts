import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createStatsRoutes } from '../routes/stats';

let dbHelper: DbHelper;
let server: http.Server;
let baseUrl: string;

async function json(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);

  // 注：种子未建 pipelines 父行（overview 期望 pipelines=0），故种子期间临时关闭外键校验
  db.run('PRAGMA foreign_keys = OFF');

  // 固定日期种子：3/10 两条（两个模型）、3/11 一条、3/12 一条（另一会话）
  const seed = [
    ['u1', 'sess-a', 'deepseek-chat', 100, 50, 0, 0, '2026-03-10 10:00:00'],
    ['u2', 'sess-a', 'gpt-4o', 200, 10, 5, 5, '2026-03-10 11:00:00'],
    ['u3', 'sess-a', 'deepseek-chat', 10, 5, 0, 0, '2026-03-11 09:00:00'],
    ['u4', 'sess-b', 'deepseek-chat', 500, 900, 0, 0, '2026-03-12 09:00:00'],
  ] as const;
  for (const [id, sid, model, i, o, cr, cc, at] of seed) {
    dbHelper.run(
      `INSERT INTO usage_records (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sid, model, i, o, cr, cc, at],
    );
  }
  dbHelper.run(
    `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status, workspaces_json, current_step_index)
     VALUES ('sess-a', 'p1', '{}', '会话A', 'r', 'completed', '[]', 0)`,
  );
  dbHelper.run(
    `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status, workspaces_json, current_step_index)
     VALUES ('sess-b', 'p1', '{}', '会话B', 'r', 'completed', '[]', 0)`,
  );
  db.run('PRAGMA foreign_keys = ON');

  const app = express();
  app.use(express.json());
  app.use('/api/stats', createStatsRoutes(dbHelper));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('GET /api/stats/usage', () => {
  it('按模型汇总（含 cache 合并列）', async () => {
    const { status, body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    expect(status).toBe(200);
    const models = body.data.models;
    const ds = models.find((m: any) => m.model === 'deepseek-chat');
    expect(ds.inputTokens).toBe(610);
    expect(ds.outputTokens).toBe(955);
    expect(ds.totalTokens).toBe(610 + 955);
    const gpt = models.find((m: any) => m.model === 'gpt-4o');
    expect(gpt.cacheTokens).toBe(10);
    expect(gpt.totalTokens).toBe(220);
  });

  it('按日期+模型分组（堆叠图数据）', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    const rows = body.data.daily;
    expect(rows).toContainEqual({ date: '2026-03-10', model: 'deepseek-chat', tokens: 150 });
    expect(rows).toContainEqual({ date: '2026-03-10', model: 'gpt-4o', tokens: 220 });
    expect(rows).toContainEqual({ date: '2026-03-12', model: 'deepseek-chat', tokens: 1400 });
  });

  it('Top5 会话按总量排序并带 kind', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    const top = body.data.topSessions;
    expect(top[0]).toMatchObject({ sessionId: 'sess-b', name: '会话B', kind: 'pipeline' });
    expect(top[0].totalTokens).toBe(1400);
    expect(top[1]).toMatchObject({ sessionId: 'sess-a', name: '会话A' });
    expect(top.length).toBeLessThanOrEqual(5);
  });

  it('日期闭区间边界生效', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-11&to=2026-03-11');
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0].inputTokens).toBe(10);
  });

  it('非法日期 400', async () => {
    const { status } = await json('/api/stats/usage?from=bad&to=2026-03-10');
    expect(status).toBe(400);
  });
});

describe('GET /api/stats/overview', () => {
  it('返回真实计数', async () => {
    const { body } = await json('/api/stats/overview');
    expect(body.data.sessionsTotal).toBe(2);
    expect(body.data.sessionsByStatus.completed).toBe(2);
    expect(body.data.resources).toBe(0);
    expect(body.data.pipelines).toBe(0);
  });
});
