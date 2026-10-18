import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ProviderRepository } from '../db/repositories/providers';
import { createProviderRoutes } from '../routes/providers';
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase;
let server: http.Server;
let upstream: http.Server;
let baseUrl: string;
let upstreamUrl: string;
let repo: ProviderRepository;
let continueYamlPath: string;

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  repo = new ProviderRepository(new DbHelper(db));

  // Mock OpenAI-protocol upstream for the /test endpoint
  const up = express();
  up.use(express.json());
  up.post('/v1/chat/completions', (_req, res) => {
    res.json({ id: 'cmpl-1', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  await new Promise<void>(r => { upstream = up.listen(0, () => r()); });
  upstreamUrl = `http://localhost:${(upstream.address() as { port: number }).port}`;

  // A Continue config.yaml on disk for import test
  continueYamlPath = path.join(os.tmpdir(), `continue-config-${Date.now()}.yaml`);
  fs.writeFileSync(continueYamlPath, `
models:
  - name: 导入的DS
    provider: deepseek
    model: deepseek-chat
    apiKey: sk-imp
    apiBase: ${upstreamUrl}
`, 'utf-8');

  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProviderRoutes(repo));
  await new Promise<void>(r => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => {
  db.close(); server.close(); upstream.close();
  fs.rmSync(continueYamlPath, { force: true });
});

async function createProvider(body: Record<string, unknown>): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${baseUrl}/api/providers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'openai', model: 'gpt-test', apiKey: 'sk-secret-9999', ...body }),
  });
  expect(res.status).toBe(201);
  const { data } = await res.json();
  return data;
}

describe('Provider routes', () => {
  it('creates, lists with masked key, gets 400 on invalid', async () => {
    const created = await createProvider({ name: '测试DS', baseUrl: upstreamUrl });
    expect(created.apiKey).toBe('****9999');

    const list = await (await fetch(`${baseUrl}/api/providers`)).json();
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    expect(list.data[0].apiKey).toMatch(/^\*\*/);

    const bad = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', protocol: 'grpc', baseUrl: 'http://x', apiKey: 'k', model: 'm' }),
    });
    expect(bad.status).toBe(400);
  });

  it('update keeps apiKey when omitted, replaces when provided', async () => {
    const p = await createProvider({ name: '改Key', baseUrl: upstreamUrl });
    const res1 = await fetch(`${baseUrl}/api/providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '改Key2' }),
    });
    const { data: d1 } = await res1.json();
    expect(d1.name).toBe('改Key2');
    expect(d1.apiKey).toBe('****9999'); // 未提供 → 保留

    await fetch(`${baseUrl}/api/providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-new-0001' }),
    });
    const got = await (await fetch(`${baseUrl}/api/providers/${p.id}`)).json();
    expect(got.data.apiKey).toBe('****0001');
  });

  it('activate switches exclusive active provider', async () => {
    const a = await createProvider({ name: 'A', baseUrl: upstreamUrl });
    const b = await createProvider({ name: 'B', baseUrl: upstreamUrl });
    await fetch(`${baseUrl}/api/providers/${a.id}/activate`, { method: 'POST' });
    await fetch(`${baseUrl}/api/providers/${b.id}/activate`, { method: 'POST' });
    const list = (await (await fetch(`${baseUrl}/api/providers`)).json()).data;
    const active = list.filter((p: { isActive: boolean }) => p.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(b.id);
  });

  it('test endpoint returns ok with latency against mock upstream', async () => {
    const p = await createProvider({ name: '连通', baseUrl: upstreamUrl });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}/test`, { method: 'POST' });
    const { data } = await res.json();
    expect(data.ok).toBe(true);
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('test endpoint reports unreachable upstream', async () => {
    const p = await createProvider({ name: '不通', baseUrl: 'http://localhost:1' });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}/test`, { method: 'POST' });
    const { data } = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('imports providers from a Continue config.yaml path', async () => {
    const res = await fetch(`${baseUrl}/api/providers/import-continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configPath: continueYamlPath }),
    });
    const { data } = await res.json();
    expect(data.imported).toHaveLength(1);
    expect(data.imported[0].name).toBe('导入的DS');
    expect(data.imported[0].source).toBe('continue');

    // 再导入一次 → 按 name+model 去重跳过
    const res2 = await fetch(`${baseUrl}/api/providers/import-continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configPath: continueYamlPath }),
    });
    const { data: d2 } = await res2.json();
    expect(d2.imported).toHaveLength(0);
    expect(d2.skipped).toBe(1);
  });

  it('deletes a provider', async () => {
    const p = await createProvider({ name: '删我', baseUrl: upstreamUrl });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const got = await fetch(`${baseUrl}/api/providers/${p.id}`);
    expect(got.status).toBe(404);
  });
});
