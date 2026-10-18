import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { PipelineRepository } from '../db/repositories/pipelines';
import { ResourceRepository } from '../db/repositories/resources';
import { StepRepository } from '../db/repositories/steps';
import { ProviderRepository } from '../db/repositories/providers';
import { createSessionRoutes } from '../routes/sessions';
import { waitForPermission } from '../ws/permission-store';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Session, Pipeline, StepTemplate } from '../../shared/types';

let db: SqlJsDatabase;
let dbHelper: DbHelper;
let server: http.Server;
let baseUrl: string;
let sessionRepo: SessionRepository;
let stepRepo: StepRepository;
let providerRepo: ProviderRepository;
let appWithProviders: http.Server;
let providerApiBase: string;   // 指向带 providerRepo 的第二个路由实例
let executorFactoryCalls: Session[];
let pipeline: Pipeline;

const neverEnding = async function* (): AsyncGenerator<unknown> {
  await new Promise(() => {});
};

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  sessionRepo = new SessionRepository(dbHelper);
  const pipelineRepo = new PipelineRepository(dbHelper);
  stepRepo = new StepRepository(dbHelper);
  const resourceRepo = new ResourceRepository(dbHelper);

  const templates: StepTemplate[] = [
    { id: 't1', name: '步骤A', category: '需求', description: '', systemPrompt: 'a', interactionMode: 'auto', autoAdvance: true, pauseForQuestions: false, collectActionItems: false, loopEnabled: false, outputFormat: 'markdown' },
    { id: 't2', name: '步骤B', category: '实现', description: '', systemPrompt: 'b', interactionMode: 'auto', autoAdvance: true, pauseForQuestions: false, collectActionItems: false, loopEnabled: false, outputFormat: 'markdown' },
  ];
  for (const t of templates) stepRepo.create(t);

  pipeline = {
    id: 'pipe-1',
    name: '测试流水线',
    description: '',
    steps: [
      { id: 'ps1', templateId: 't1', order: 1 },
      { id: 'ps2', templateId: 't2', order: 2 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  pipelineRepo.create(pipeline);

  executorFactoryCalls = [];
  const wsChannel = { broadcastToSession: () => {} } as never;

  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createSessionRoutes(dbHelper, {
    wsChannel,
    resourceRepo,
    stepRepo,
    executorFactory: (session) => {
      executorFactoryCalls.push(session);
      return neverEnding();
    },
  }));
  app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });

  providerRepo = new ProviderRepository(dbHelper);

  const app2 = express();
  app2.use(express.json());
  app2.use('/api/sessions', createSessionRoutes(dbHelper, {
    wsChannel,
    resourceRepo,
    stepRepo,
    providerRepo,
    executorFactory: (session) => { executorFactoryCalls.push(session); return neverEnding(); },
  }));
  await new Promise<void>((resolve) => {
    appWithProviders = app2.listen(0, () => {
      providerApiBase = `http://localhost:${(appWithProviders.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  db.close();
  if (server) server.close();
});

async function createSession(name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pipelineId: 'pipe-1',
      name,
      requirement: '需求描述',
      workspaces: [{ name: 'backend', path: 'D:/tmp/proj', type: 'backend' }],
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.data.id as string;
}

describe('Session routes', () => {
  it('stores the step template name (not its id) when creating a session', async () => {
    const id = await createSession('名称测试');
    const res = await fetch(`${baseUrl}/api/sessions/${id}`);
    const body = await res.json();
    expect(body.data.steps[0].stepName).toBe('步骤A');
    expect(body.data.steps[1].stepName).toBe('步骤B');
  });

  it('rejects a second start while the session is already running', async () => {
    const id = await createSession('重复启动测试');
    const first = await fetch(`${baseUrl}/api/sessions/${id}/start`, { method: 'POST' });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/api/sessions/${id}/start`, { method: 'POST' });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.success).toBe(false);
  });

  it('relaunches the executor when resuming from waiting_confirm', async () => {
    const id = await createSession('恢复测试');
    sessionRepo.updateStatus(id, 'waiting_confirm', { currentStepIndex: 1 });
    executorFactoryCalls.length = 0;

    const res = await fetch(`${baseUrl}/api/sessions/${id}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('running');
    expect(body.data.currentStepIndex).toBe(1);
    expect(executorFactoryCalls.length).toBe(1);
  });

  it('denies all pending permission requests when the session is cancelled', async () => {
    const id = await createSession('取消测试');
    const pending = waitForPermission('perm-route-cancel', id);

    const res = await fetch(`${baseUrl}/api/sessions/${id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);

    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('permission was not resolved on cancel')), 1_000)),
    ]);
    expect(result.behavior).toBe('deny');
  });
});

describe('Session start requires an active provider', () => {
  it('rejects start/resume with 400 when no provider is active', async () => {
    const id = await createSession('无供应商');
    // 走带 providerRepo 的实例；此时无激活供应商
    const res = await fetch(`${providerApiBase}/api/sessions/${id}/start`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('供应商');

    const res2 = await fetch(`${providerApiBase}/api/sessions/${id}/resume`, { method: 'POST' });
    expect(res2.status).toBe(400);
  });

  it('allows start once a provider is active', async () => {
    const p = providerRepo.create({
      name: 'DS', protocol: 'openai', baseUrl: 'http://localhost:9', apiKey: 'sk-x',
      model: 'deepseek-chat', isActive: false, source: 'manual',
    });
    providerRepo.activate(p.id);
    const id = await createSession('有供应商');
    const res = await fetch(`${providerApiBase}/api/sessions/${id}/start`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
