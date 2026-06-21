import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { StepRepository } from '../db/repositories/steps';
import type { StepTemplate } from '../../shared/types';
import type { Database as SqlJsDatabase } from 'sql.js';

describe('StepRepository', () => {
  let db: SqlJsDatabase;
  let helper: DbHelper;
  let repo: StepRepository;

  beforeAll(async () => {
    db = await createMemoryDb();
    createTables(db);
    helper = new DbHelper(db);
    repo = new StepRepository(helper);
  });

  afterAll(() => db.close());
  beforeEach(() => db.run("DELETE FROM step_templates"));

  const makeStep = (overrides: Partial<StepTemplate> = {}): StepTemplate => ({
    id: 'step-1',
    name: 'Code Review',
    category: '评审',
    description: 'Review code for quality',
    systemPrompt: 'You are a code reviewer...',
    interactionMode: 'auto-with-review',
    autoAdvance: true,
    pauseForQuestions: false,
    collectActionItems: true,
    loopEnabled: false,
    outputFormat: 'markdown',
    ...overrides,
  });

  describe('create', () => {
    it('should create a step template', () => {
      const step = makeStep();
      const created = repo.create(step);
      expect(created.id).toBe('step-1');
      expect(created.name).toBe('Code Review');
      expect(created.interactionMode).toBe('auto-with-review');
    });

    it('should store config_json with resource references', () => {
      repo.create(makeStep({
        agentId: 'agent-1',
        skillIds: ['skill-a', 'skill-b'],
        mcpServerIds: ['mcp-1'],
      }));
      const row = helper.get<{ config_json: string }>("SELECT config_json FROM step_templates WHERE id = ?", ['step-1']);
      const config = JSON.parse(row!.config_json);
      expect(config.agentId).toBe('agent-1');
      expect(config.skillIds).toEqual(['skill-a', 'skill-b']);
    });

    it('should store loop config', () => {
      repo.create(makeStep({
        loopEnabled: true,
        defaultLoopConfig: {
          maxIterations: 5,
          terminationMode: 'ai-judge',
          terminationPrompt: 'Are all tests passing?',
        },
      }));
      const found = repo.getById('step-1');
      expect(found?.defaultLoopConfig?.maxIterations).toBe(5);
      expect(found?.defaultLoopConfig?.terminationMode).toBe('ai-judge');
    });
  });

  describe('getById and list', () => {
    it('should get by id', () => {
      repo.create(makeStep({ id: 's1', name: 'Step 1' }));
      const found = repo.getById('s1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Step 1');
    });

    it('should return null for unknown id', () => {
      expect(repo.getById('nope')).toBeNull();
    });

    it('should list all', () => {
      repo.create(makeStep({ id: 's1', name: 'A' }));
      repo.create(makeStep({ id: 's2', name: 'B' }));
      expect(repo.list()).toHaveLength(2);
    });

    it('should filter by category', () => {
      repo.create(makeStep({ id: 's1', category: '评审' }));
      repo.create(makeStep({ id: 's2', category: '实现' }));
      const results = repo.list({ category: '评审' });
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe('评审');
    });
  });

  describe('update and delete', () => {
    it('should update step fields', () => {
      repo.create(makeStep());
      const updated = repo.update('step-1', { name: 'New Name', autoAdvance: false });
      expect(updated?.name).toBe('New Name');
      expect(updated?.autoAdvance).toBe(false);
    });

    it('should delete step', () => {
      repo.create(makeStep());
      expect(repo.delete('step-1')).toBe(true);
      expect(repo.getById('step-1')).toBeNull();
    });
  });
});
