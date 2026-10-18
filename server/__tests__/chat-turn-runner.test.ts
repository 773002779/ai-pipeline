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

  it('WS 事件转发：running→ai_message 流→idle 状态广播', async () => {
    broadcasts.length = 0;
    const session = makeSession('r7', 'm');
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'ai_stream', content: 'A', done: false };
      yield { type: 'thinking_stream', content: 't', done: false };
      yield { type: 'tool_use', toolName: 'Read', input: { file_path: '/x' } };
      yield { type: 'ai_stream', content: 'B', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, 'hi', 'm');
    await flush();

    expect(broadcasts.map(b => b.type)).toEqual([
      'status_change',
      'ai_message',
      'thinking_delta',
      'tool_use',
      'ai_message',
      'ai_message',
      'status_change',
    ]);
    expect(broadcasts[0]).toEqual({ type: 'status_change', data: { status: 'running', currentStepIndex: 0 } });
    expect(broadcasts[1]).toEqual({ type: 'ai_message', data: { content: 'A', done: false } });
    expect(broadcasts[2]).toEqual({ type: 'thinking_delta', data: { content: 't', done: false } });
    expect(broadcasts[3]).toEqual({ type: 'tool_use', data: { toolName: 'Read', input: { file_path: '/x' } } });
    expect(broadcasts[4]).toEqual({ type: 'ai_message', data: { content: 'B', done: false } });
    expect(broadcasts[5]).toEqual({ type: 'ai_message', data: { content: '', done: true } });
    expect(broadcasts[6]).toEqual({ type: 'status_change', data: { status: 'idle', currentStepIndex: 0 } });
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

  it('首条消息回填会话名与 requirement；后续轮不覆盖', async () => {
    const session = makeSession('r8');
    const longContent = '帮我把这个仓库的登录模块重构成 React hooks 并且补全测试覆盖';
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'ai_stream', content: 'ok', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, longContent, 'm');
    await flush();
    expect(sessionRepo.getById('r8')!.name).toBe(longContent.slice(0, 20));
    expect(sessionRepo.getById('r8')!.requirement).toBe(longContent);

    runner.startTurn(sessionRepo.getById('r8')!, '第二条消息', 'm');
    await flush();
    expect(sessionRepo.getById('r8')!.requirement).toBe(longContent);
    expect(sessionRepo.getById('r8')!.name).toBe(longContent.slice(0, 20));
  });

  it('startCompact：resume 旧会话、禁工具，摘要落库、句柄清空、系统消息、状态 idle', async () => {
    broadcasts.length = 0;
    const session = makeSession('r9');
    sessionRepo.updateChatFields('r9', { chatSdkSessionId: 'sdk-old' });
    let captured: any;
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      captured = cfg;
      yield { type: 'usage', model: 'm', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      yield { type: 'ai_stream', content: '任务目标：重构登录。未完成：补测试。', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startCompact(sessionRepo.getById('r9')!, 'm');
    await flush();

    expect(captured.disableTools).toBe(true);
    expect(captured.resumeSessionId).toBe('sdk-old');
    expect(captured.prompt).toContain('只输出摘要正文');
    // 静默轮：摘要流不广播（否则前端瞬时气泡在 idle 回读后消失）；仅 running→idle 两次状态广播
    expect(broadcasts.some(b => b.type === 'ai_message')).toBe(false);
    expect(broadcasts.some(b => b.type === 'thinking_delta')).toBe(false);
    expect(broadcasts.filter(b => b.type === 'status_change').map(b => b.data.status)).toEqual(['running', 'idle']);
    const loaded = sessionRepo.getById('r9')!;
    expect(loaded.chatSummary).toContain('未完成：补测试');
    expect(loaded.chatSdkSessionId).toBeUndefined();
    expect(loaded.status).toBe('idle');
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r9' AND role = 'system'",
    );
    expect(sysMsgs.some(m => String(m['content']).includes('上下文已压缩'))).toBe(true);
  });

  it('startCompact：无 SDK 会话时 no-op（系统消息「对话为空」，不占 running）', async () => {
    const session = makeSession('r10');
    let called = false;
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      called = true;
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startCompact(session, 'm');
    await flush();

    expect(called).toBe(false);
    expect(runner.isRunning('r10')).toBe(false);
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r10' AND role = 'system'",
    );
    expect(sysMsgs.some(m => String(m['content']).includes('对话为空'))).toBe(true);
    expect(sessionRepo.getById('r10')!.status).toBe('idle');
  });

  it('startCompact：摘要轮失败 → 状态 error + 系统消息提示重试', async () => {
    const session = makeSession('r11');
    sessionRepo.updateChatFields('r11', { chatSdkSessionId: 'sdk-old' });
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'turn_error', error: '上游 500' };
    });

    runner.startCompact(sessionRepo.getById('r11')!, 'm');
    await flush();

    expect(sessionRepo.getById('r11')!.status).toBe('error');
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r11' AND role = 'system'",
    );
    expect(sysMsgs.some(m => String(m['content']).includes('压缩失败'))).toBe(true);
  });

  it('startTurn：存在摘要且无 SDK 会话 → prompt 注入摘要块，新 sdk_session 后摘要清除', async () => {
    const session = makeSession('r12');
    sessionRepo.updateChatFields('r12', { chatSummary: '这是历史摘要' });
    const prompts: string[] = [];
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      prompts.push(cfg.prompt);
      yield { type: 'sdk_session', sdkSessionId: 'sdk-new' };
      yield { type: 'ai_stream', content: 'ok', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(sessionRepo.getById('r12')!, '继续', 'm');
    await flush();

    expect(prompts[0].startsWith('## Previous Conversation Summary')).toBe(true);
    expect(prompts[0]).toContain('这是历史摘要');
    expect(prompts[0]).toContain('继续');
    expect(sessionRepo.getById('r12')!.chatSummary).toBeUndefined();
    expect(sessionRepo.getById('r12')!.chatSdkSessionId).toBe('sdk-new');
  });

  it('startTurn：skill 参数 → prompt 末尾追加 Skill 块', async () => {
    const session = makeSession('r13');
    let captured = '';
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      captured = cfg.prompt;
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '按流程来', 'm', { name: 'code-review', prompt: '审查代码时逐文件检查' });
    await flush();

    expect(captured).toContain('## Skill: code-review');
    expect(captured).toContain('审查代码时逐文件检查');
    expect(captured.indexOf('## Skill: code-review')).toBeGreaterThan(captured.indexOf('按流程来'));
  });
});
