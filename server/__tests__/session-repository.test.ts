import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { PipelineRepository } from '../db/repositories/pipelines';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { Session, Pipeline } from '../../shared/types';

let db: SqlJsDatabase;
let repo: SessionRepository;
let pipelineRepo: PipelineRepository;

const pipeline: Pipeline = {
  id: 'pipe-1',
  name: 'P',
  description: '',
  steps: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeSession(steps: Session['steps']): Session {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    pipelineId: pipeline.id,
    pipelineSnapshot: pipeline,
    name: 'S',
    requirement: 'R',
    status: 'idle',
    workspaces: [],
    currentStepIndex: 0,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  pipelineRepo = new PipelineRepository(new DbHelper(db));
  repo = new SessionRepository(new DbHelper(db));
  pipelineRepo.create(pipeline);
});

afterAll(() => {
  db.close();
});

describe('SessionRepository.updateStepStatus', () => {
  it('updates only the step at the given position when names collide', () => {
    const session = makeSession([
      { templateId: 't1', stepName: '实现', status: 'pending', retryCount: 0 },
      { templateId: 't1', stepName: '实现', status: 'pending', retryCount: 0 },
    ]);
    repo.create(session);

    repo.updateStepStatus(session.id, 1, 'running', { startedAt: '2026-01-01T00:00:00.000Z' });

    const steps = repo.getById(session.id)!.steps;
    expect(steps[0].status).toBe('pending');
    expect(steps[1].status).toBe('running');
    expect(steps[1].startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('completes the first step without touching the second', () => {
    const session = makeSession([
      { templateId: 't1', stepName: '评审', status: 'running', retryCount: 0 },
      { templateId: 't2', stepName: '测试', status: 'pending', retryCount: 0 },
    ]);
    repo.create(session);

    repo.updateStepStatus(session.id, 0, 'completed', {
      completedAt: '2026-01-02T00:00:00.000Z',
      outputPath: 'D:/out/step-01.md',
    });

    const steps = repo.getById(session.id)!.steps;
    expect(steps[0].status).toBe('completed');
    expect(steps[0].outputPath).toBe('D:/out/step-01.md');
    expect(steps[1].status).toBe('pending');
  });

  it('records retry count and clears error state', () => {
    const session = makeSession([
      { templateId: 't1', stepName: '步骤', status: 'error', retryCount: 0, errorMessage: 'boom' },
    ]);
    repo.create(session);

    repo.updateStepStatus(session.id, 0, 'running', {
      retryCount: 1,
      errorMessage: undefined,
      outputPath: undefined,
    });

    const steps = repo.getById(session.id)!.steps;
    expect(steps[0].status).toBe('running');
    expect(steps[0].retryCount).toBe(1);
    expect(steps[0].errorMessage).toBeUndefined();
  });

  it('ignores out-of-range step indexes', () => {
    const session = makeSession([
      { templateId: 't1', stepName: '唯一', status: 'pending', retryCount: 0 },
    ]);
    repo.create(session);

    expect(() => repo.updateStepStatus(session.id, 5, 'running', {})).not.toThrow();
    expect(repo.getById(session.id)!.steps[0].status).toBe('pending');
  });
});
