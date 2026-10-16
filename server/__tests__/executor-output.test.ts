import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { StepRepository } from '../db/repositories/steps';
import { PipelineRepository } from '../db/repositories/pipelines';
import { PipelineExecutor, } from '../engine/executor';
import type { AgentEvent, AgentCallConfig } from '../claude/agent-manager';
import type { SessionChannel } from '../ws/session-channel';
import type { Session, StepTemplate, Pipeline } from '../../shared/types';

let dbHelper: DbHelper;
let sessionRepo: SessionRepository;
let stepRepo: StepRepository;
let pipelineRepo: PipelineRepository;
let outputDir: string;

beforeEach(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  sessionRepo = new SessionRepository(dbHelper);
  stepRepo = new StepRepository(dbHelper);
  pipelineRepo = new PipelineRepository(dbHelper);
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-out-'));
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

function makeTemplate(overrides: Partial<StepTemplate> = {}): StepTemplate {
  return {
    id: 't1',
    name: '输出测试',
    category: '实现',
    description: '',
    systemPrompt: 'Do it',
    interactionMode: 'auto',
    autoAdvance: true,
    pauseForQuestions: false,
    collectActionItems: false,
    loopEnabled: false,
    outputFormat: 'markdown',
    ...overrides,
  };
}

function makePipeline(stepTemplates: StepTemplate[]): Pipeline {
  const now = new Date().toISOString();
  return {
    id: 'pipe1',
    name: 'Test Pipeline',
    description: '',
    steps: stepTemplates.map((t, i) => ({ id: `ps${i + 1}`, templateId: t.id, order: i + 1 })),
    createdAt: now,
    updatedAt: now,
  };
}

function makeSession(pipeline: Pipeline, stepStatuses: Session['steps']): Session {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    pipelineId: pipeline.id,
    pipelineSnapshot: pipeline,
    name: 'Test Session',
    requirement: 'Do the thing',
    status: 'idle',
    workspaces: [{ name: 'ws', path: 'D:/tmp/some-proj', type: 'unknown' }],
    currentStepIndex: 0,
    steps: stepStatuses,
    createdAt: now,
    updatedAt: now,
  };
}

type FakeYield = (cfg: AgentCallConfig) => AsyncGenerator<AgentEvent>;

/** Replace the real agent manager (which spawns the Claude CLI) with a scripted one */
function injectAgentManager(executor: PipelineExecutor, script: FakeYield): void {
  (executor as unknown as { agentManager: { execute: FakeYield } }).agentManager = { execute: script };
}

const fakeChannel = { broadcastToSession: () => {} } as unknown as SessionChannel;

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('PipelineExecutor output persistence', () => {
  it('saves the accumulated AI content as the step output document', async () => {
    const template = makeTemplate();
    stepRepo.create(template);
    const pipeline = makePipeline([template]);
    pipelineRepo.create(pipeline);
    const session = makeSession(pipeline, [
      { templateId: 't1', stepName: '输出测试', status: 'pending', retryCount: 0 },
    ]);
    sessionRepo.create(session);

    const executor = new PipelineExecutor(sessionRepo, {} as never, stepRepo);
    injectAgentManager(executor, async function* () {
      yield { type: 'ai_stream', stepId: 'ps1', content: 'REAL OUTPUT CONTENT', done: false, tokens: 1 };
      yield { type: 'ai_stream', stepId: 'ps1', content: '', done: true, tokens: 1 };
      yield { type: 'step_complete', stepId: 'ps1', output: 'Step completed. Tokens used: 1', timestamp: new Date().toISOString() };
    });

    await drain(executor.execute(session, fakeChannel, outputDir));

    const files = fs.readdirSync(path.join(outputDir, session.id));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(outputDir, session.id, files[0]), 'utf-8');
    expect(content).toContain('REAL OUTPUT CONTENT');
    expect(content).not.toContain('Tokens used');
  });

  it('marks the session completed and stores the output path', async () => {
    const template = makeTemplate();
    stepRepo.create(template);
    const pipeline = makePipeline([template]);
    pipelineRepo.create(pipeline);
    const session = makeSession(pipeline, [
      { templateId: 't1', stepName: '输出测试', status: 'pending', retryCount: 0 },
    ]);
    sessionRepo.create(session);

    const executor = new PipelineExecutor(sessionRepo, {} as never, stepRepo);
    injectAgentManager(executor, async function* () {
      yield { type: 'ai_stream', stepId: 'ps1', content: 'Done work', done: true, tokens: 1 };
      yield { type: 'step_complete', stepId: 'ps1', output: 'x', timestamp: new Date().toISOString() };
    });

    await drain(executor.execute(session, fakeChannel, outputDir));

    const updated = sessionRepo.getById(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.steps[0].status).toBe('completed');
    expect(updated.steps[0].outputPath).toBeTruthy();
    expect(fs.existsSync(updated.steps[0].outputPath!)).toBe(true);
  });

  it('passes previous step outputs with a usable path to the next step', async () => {
    const t1 = makeTemplate({ id: 't1', name: '第一步' });
    const t2 = makeTemplate({ id: 't2', name: '第二步' });
    stepRepo.create(t1);
    stepRepo.create(t2);
    const pipeline = makePipeline([t1, t2]);
    pipelineRepo.create(pipeline);
    const now = new Date().toISOString();
    const firstOutputPath = path.join(outputDir, 'step-01.md');
    fs.writeFileSync(firstOutputPath, '# First output', 'utf-8');

    const session: Session = {
      ...makeSession(pipeline, [
        { templateId: 't1', stepName: '第一步', status: 'completed', retryCount: 0, outputPath: firstOutputPath, completedAt: now },
        { templateId: 't2', stepName: '第二步', status: 'pending', retryCount: 0 },
      ]),
      currentStepIndex: 1,
    };
    sessionRepo.create(session);
    // create() resets nothing; set step 1 completed state explicitly
    sessionRepo.updateStepStatus(session.id, 0, 'completed', { outputPath: firstOutputPath, completedAt: now });
    sessionRepo.updateStepStatus(session.id, 1, 'pending', {});
    sessionRepo.updateStatus(session.id, 'running', { currentStepIndex: 1 });

    let captured: AgentCallConfig | null = null;
    const executor = new PipelineExecutor(sessionRepo, {} as never, stepRepo);
    injectAgentManager(executor, async function* (cfg) {
      captured = cfg;
      yield { type: 'ai_stream', stepId: 'ps2', content: 'Second step output', done: true, tokens: 1 };
      yield { type: 'step_complete', stepId: 'ps2', output: 'x', timestamp: new Date().toISOString() };
    });

    await drain(executor.execute(session, fakeChannel, outputDir));

    expect(captured).not.toBeNull();
    const prev = captured!.previousOutputs;
    expect(prev.length).toBe(1);
    expect(prev[0].path).toBe(firstOutputPath);
    expect(prev[0].path).not.toBe(undefined);
  });

  it('persists the assistant message including thinking into the messages table', async () => {
    const template = makeTemplate();
    stepRepo.create(template);
    const pipeline = makePipeline([template]);
    pipelineRepo.create(pipeline);
    const session = makeSession(pipeline, [
      { templateId: 't1', stepName: '输出测试', status: 'pending', retryCount: 0 },
    ]);
    sessionRepo.create(session);

    const executor = new PipelineExecutor(sessionRepo, {} as never, stepRepo);
    injectAgentManager(executor, async function* () {
      yield { type: 'thinking_stream', stepId: 'ps1', content: 'Hmm let me think', done: false };
      yield { type: 'thinking_stream', stepId: 'ps1', content: '', done: true };
      yield { type: 'ai_stream', stepId: 'ps1', content: 'Final answer text', done: true, tokens: 1 };
      yield { type: 'step_complete', stepId: 'ps1', output: 'x', timestamp: new Date().toISOString() };
    });

    await drain(executor.execute(session, fakeChannel, outputDir));

    const msgs = dbHelper.all<Record<string, unknown>>(
      'SELECT * FROM messages WHERE session_id = ?', [session.id]
    );
    expect(msgs.length).toBe(1);
    expect(msgs[0]['content']).toBe('Final answer text');
    expect(msgs[0]['thinking_json']).toContain('Hmm let me think');
  });
});
