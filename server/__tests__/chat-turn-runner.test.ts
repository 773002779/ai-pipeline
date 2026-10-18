import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { ChatTurnRunner } from '../chat/turn-runner';
import type { ChatTurnEvent } from '../claude/agent-manager';
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Session } from '../../shared/types';

let dbHelper: DbHelper;
let sessionRepo: SessionRepository;
let usageRepo: UsageRepository;
const broadcasts: Array<{ type: string; data: any }> = [];
const wsChannel = { broadcastToSession: (_id: string, e: any) => broadcasts.push(e) } as never;

function makeSession(id: string, chatModel?: string): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id, pipelineId: BUILTIN_CHAT_PIPELINE_ID,
    pipelineSnapshot: { id: BUILTIN_CHAT_PIPELINE_ID, name: '自由对话', description: '', steps: [], createdAt: now, updatedAt: now },
    name: '新对话', requirement: '', status: 'idle',
    workspaces: [{ name: 'ws', path: process.cwd(), type: 'unknown' }],
    currentStepIndex: 0, steps: [], chatModel,
    createdAt: now, updatedAt: now,
  };
  sessionRepo.create(s);
  return s;
}

function runnerWith(script: (cfg: any) => AsyncGenerator<ChatTurnEvent>): ChatTurnRunner {
  return new ChatTurnRunner({
    sessionRepo, usageRepo, wsChannel,
    agentManager: { executeChatTurn: (cfg) => script(cfg) },
  });
}

const flush = () => new Promise(r => setTimeout(r, 20));

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  ensureBuiltinChatPipeline(dbHelper);
  sessionRepo = new SessionRepository(dbHelper);
  usageRepo = new UsageRepository(dbHelper);
});

describe('ChatTurnRunner', () => {
  it('一轮完整对话：用户消息、流式、助手消息、usage、状态回 idle', async () => {
    const session = makeSession('r1');
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'sdk_session', sdkSessionId: 'sdk-xyz' };
      yield { type: 'ai_stream', content: '你', done: false };
      yield { type: 'ai_stream', content: '好', done: false };
      yield { type: 'usage', model: 'deepseek-chat', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '打个招呼', 'deepseek-chat');
    await flush();

    expect(runner.isRunning('r1')).toBe(false);
    const msgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r1' ORDER BY created_at",
    );
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]['content']).toBe('你好');
    const usageRow = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'r1'",
    );
    expect(usageRow!['model']).toBe('deepseek-chat');
    const loaded = sessionRepo.getById('r1')!;
    expect(loaded.chatSdkSessionId).toBe('sdk-xyz');
    expect(loaded.status).toBe('idle');
  });

  it('@引用注入 prompt 且越界引用被剔除', async () => {
    const session = makeSession('r2');
    let capturedPrompt = '';
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      capturedPrompt = cfg.prompt;
      yield { type: 'ai_stream', content: 'ok', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '看 @package.json 和 @../escape.txt', 'm');
    await flush();
    expect(capturedPrompt).toContain('## Referenced Files');
    expect(capturedPrompt).toContain('package.json');
    // 越界引用不得进入引用块（原始消息文本本身仍会包含 @../escape.txt，此处只校验注入的引用块）
    const block = capturedPrompt.slice(capturedPrompt.indexOf('## Referenced Files'));
    expect(block).not.toContain('../escape.txt');
  });

  it('会话级模型优先于默认模型', async () => {
    const session = makeSession('r3', 'session-model');
    let capturedModel: string | undefined;
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      capturedModel = cfg.model;
      yield { type: 'ai_stream', content: '', done: true };
    });
    runner.startTurn(session, 'hi', 'default-model');
    await flush();
    expect(capturedModel).toBe('session-model');
  });

  it('stop 中断：保留已生成内容，状态回 idle', async () => {
    const session = makeSession('r4');
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'ai_stream', content: '部分', done: false };
      await new Promise<void>((resolve) => {
        if (cfg.abortController.signal.aborted) return resolve();
        cfg.abortController.signal.addEventListener('abort', () => resolve());
      });
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '长任务', 'm');
    await flush();
    expect(runner.isRunning('r4')).toBe(true);
    expect(runner.stop('r4')).toBe(true);
    await flush();
    expect(runner.isRunning('r4')).toBe(false);
    const msgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r4' AND role = 'assistant'",
    );
    expect(msgs[0]['content']).toBe('部分');
    expect(sessionRepo.getById('r4')!.status).toBe('idle');
  });

  it('turn_error → 状态 error', async () => {
    const session = makeSession('r5');
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'turn_error', error: '上游 500' };
    });
    runner.startTurn(session, 'hi', 'm');
    await flush();
    expect(sessionRepo.getById('r5')!.status).toBe('error');
  });
});
