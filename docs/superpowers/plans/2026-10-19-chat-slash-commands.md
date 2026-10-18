# 用户气泡对比度 + 对话 / 命令 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复白色主题下用户气泡文字对比度；为 Claude 对话页实现 `/` 命令：`/clear`（重置模型上下文）、`/compact`（隐藏摘要轮压缩上下文）、`/<skill名>`（注入 skill prompt 走正常轮次），服务端统一分发。

**Architecture:** 命令解析为纯函数 `parseChatCommand`（`server/chat/commands.ts`）；内置命令在 `POST /api/chat/:id/messages` 内直接处理（不走 LLM），`/compact` 由 `ChatTurnRunner.startCompact` 执行隐藏摘要轮（resume 当前会话 + `disableTools` 禁工具），摘要存 `sessions.chat_summary` 新列，`startTurn` 检测到摘要时在 prompt 前注入、拿到新 SDK 会话后清除。skill 命令由 routes 层查资源仓库解析后以 `startTurn` 第 4 参传入，runner 组装 prompt 时追加 `## Skill` 块。前端 `Mentions` 双前缀 `['@','/']`，按触发前缀切换候选。

**Tech Stack:** Express + sql.js + vitest（服务端）；React 18 + antd 5 Mentions（前端）。无新增运行时依赖。

**设计文档:** `docs/superpowers/specs/2026-10-19-chat-slash-commands-design.md`

## Global Constraints

- TDD：先写失败测试再实现；`npm test` 基线 **195** 全绿；`npx tsc --noEmit` 干净；本计划不新增运行时依赖。
- `/clear` 语义：仅重置模型上下文（清 `chat_sdk_session_id` + `chat_summary`），聊天记录与会话级模型选择（`chat_model`）保留。
- 内置命令文本本身不写入 messages 表，仅插入系统结果消息（role='system'）。
- `/compact` 摘要轮 `tools: []`（禁工具，避免权限弹窗卡住）；usage 照常落库。
- 摘要注入：prompt 前置 `## Previous Conversation Summary` 块；该轮拿到新 `sdk_session` 后清除 `chat_summary`。
- 未知命令 400 文案：`未知命令 /<name>，可用：/clear、/compact 或已启用的 skill`。
- UI 文案中文；提交信息中文 conventional commits；分支 `feature/llm-providers`。
- 客户端测试需要 `// @vitest-environment jsdom`（本计划无新客户端测试）。

---

### Task 1: 用户气泡对比度修复

**Files:**
- Modify: `src/components/ChatMessages.tsx:26-36`

**Interfaces:**
- Consumes: 无。
- Produces: 无（纯样式修复，其他任务不依赖）。

- [ ] **Step 1: 修改气泡文字色**

`src/components/ChatMessages.tsx` 当前气泡样式（第 26-36 行）：

```tsx
          <div style={{
            maxWidth: '85%', padding: '8px 12px', borderRadius: 8,
            background: m.role === 'user' ? token.colorPrimary
              : m.role === 'system' ? token.colorFillSecondary : token.colorFillTertiary,
            color: m.role === 'system' ? token.colorWarning : token.colorText,
            border: m.role === 'system' ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}>
            <Typography.Text style={{ color: token.colorTextSecondary, fontSize: 10, display: 'block' }}>
```

改为（用户气泡文字恒白、时间戳半透明白；助手/系统分支不动）：

```tsx
          <div style={{
            maxWidth: '85%', padding: '8px 12px', borderRadius: 8,
            background: m.role === 'user' ? token.colorPrimary
              : m.role === 'system' ? token.colorFillSecondary : token.colorFillTertiary,
            color: m.role === 'user' ? token.colorTextLightSolid
              : m.role === 'system' ? token.colorWarning : token.colorText,
            border: m.role === 'system' ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}>
            <Typography.Text style={{
              color: m.role === 'user' ? 'rgba(255,255,255,0.8)' : token.colorTextSecondary,
              fontSize: 10, display: 'block',
            }}>
```

- [ ] **Step 2: 全量验证**

Run: `npm test && npx tsc --noEmit`
Expected: 195/195 通过，tsc 无错（本任务无新测试；视觉验证归手动验收清单）。

- [ ] **Step 3: Commit**

```bash
git add src/components/ChatMessages.tsx
git commit -m "fix: 用户气泡文字改 colorTextLightSolid，修复白色主题下蓝底黑字对比度"
```

---

### Task 2: 命令解析 + /clear + /compact（服务端）

**Files:**
- Create: `server/chat/commands.ts`
- Create: `server/__tests__/chat-commands.test.ts`
- Modify: `shared/types.ts`（Session.chatSummary）
- Modify: `server/db/schema.ts`（chat_summary 迁移）
- Modify: `server/db/repositories/sessions.ts`（updateChatFields 扩展 + resetChatContext）
- Modify: `server/__tests__/chat-session-repository.test.ts`（追加用例）
- Modify: `server/claude/agent-manager.ts`（ChatTurnConfig.disableTools）
- Modify: `server/chat/turn-runner.ts`（整体重构：beginTurn/driveTurn/endTurn + startCompact + 摘要注入 + skill 参数位）
- Modify: `server/__tests__/chat-turn-runner.test.ts`（追加用例）
- Modify: `server/routes/chat.ts`（命令分发）
- Modify: `server/__tests__/chat-routes.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现有 `ChatTurnConfig`/`ChatTurnEvent`、`updateChatFields`、`parseMentions`。
- Produces:
  - `parseChatCommand(content: string): ChatCommand | null`，`ChatCommand = { type: 'clear' } | { type: 'compact' } | { type: 'skill'; name: string }`（非命令 → null；`/` 或 `/ ` 等空 token → null）
  - `buildCompactPrompt(): string`、`buildSkillBlock(skill?: { name: string; prompt: string }): string`
  - `SessionRepository.updateChatFields(id, fields: { chatSdkSessionId?: string; chatModel?: string; chatSummary?: string })`（签名扩展，语义不变：先读后写、未传字段保留原值）
  - `SessionRepository.resetChatContext(id): void`（清 chatSdkSessionId + chatSummary，保留 chatModel）
  - `Session.chatSummary?: string`（shared）
  - `ChatTurnConfig.disableTools?: boolean`
  - `ChatTurnRunner.startTurn(session, content, defaultModel?, skill?: { name: string; prompt: string })`（第 4 参；Task 3 使用）
  - `ChatTurnRunner.startCompact(session: Session, defaultModel?: string): void`

- [ ] **Step 1: 写失败测试（纯函数）**

`server/__tests__/chat-commands.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseChatCommand, buildCompactPrompt, buildSkillBlock } from '../chat/commands';

describe('parseChatCommand', () => {
  it('识别 /clear 与 /compact（忽略大小写不必要，精确匹配）', () => {
    expect(parseChatCommand('/clear')).toEqual({ type: 'clear' });
    expect(parseChatCommand('/clear 现在')).toEqual({ type: 'clear' });
    expect(parseChatCommand('  /compact  ')).toEqual({ type: 'compact' });
  });

  it('非命令返回 null', () => {
    expect(parseChatCommand('你好')).toBeNull();
    expect(parseChatCommand('看看 /clear 这个词')).toBeNull(); // 不以 / 开头
  });

  it('/ 与 "/ 空格" 视为非命令', () => {
    expect(parseChatCommand('/')).toBeNull();
    expect(parseChatCommand('/ clear')).toBeNull();
  });

  it('其余 /token 解析为 skill 命令', () => {
    expect(parseChatCommand('/code-review 帮我审查')).toEqual({ type: 'skill', name: 'code-review' });
    expect(parseChatCommand('/代码审查')).toEqual({ type: 'skill', name: '代码审查' });
  });
});

describe('buildCompactPrompt', () => {
  it('包含摘要指令的结构化要求', () => {
    const p = buildCompactPrompt();
    expect(p).toContain('摘要');
    expect(p).toContain('未完成事项');
    expect(p).toContain('只输出摘要正文');
  });
});

describe('buildSkillBlock', () => {
  it('无 skill 返回空串', () => {
    expect(buildSkillBlock(undefined)).toBe('');
  });

  it('生成 Skill 注入块', () => {
    const block = buildSkillBlock({ name: 'code-review', prompt: '审查代码时…' });
    expect(block).toBe('## Skill: code-review\n\n审查代码时…');
  });
});
```

Run: `npx vitest run server/__tests__/chat-commands.test.ts`
Expected: FAIL（Cannot find module '../chat/commands'）

- [ ] **Step 2: 实现 commands.ts**

`server/chat/commands.ts`：

```ts
/** / 命令解析（服务端分发）。非命令返回 null；空 token（"/"、"/ clear"）视为非命令。 */
export type ChatCommand =
  | { type: 'clear' }
  | { type: 'compact' }
  | { type: 'skill'; name: string };

export function parseChatCommand(content: string): ChatCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.slice(1).split(/\s/, 1)[0];
  if (!token) return null;
  if (token === 'clear') return { type: 'clear' };
  if (token === 'compact') return { type: 'compact' };
  return { type: 'skill', name: token };
}

/** /compact 隐藏摘要轮的固定指令 */
export function buildCompactPrompt(): string {
  return [
    '请将我们此前的对话压缩成一份结构化摘要，供后续对话作为唯一上下文使用。',
    '摘要需包含：1) 任务目标与背景；2) 已做出的关键决定与结论；3) 未完成事项与下一步；4) 后续对话所需的关键上下文（文件路径、约定、约束等）。',
    '只输出摘要正文，不要额外解释。',
  ].join('\n');
}

/** skill 命令注入的 prompt 块（与 @引用的 Referenced Files 块并列，置于 prompt 末尾） */
export function buildSkillBlock(skill?: { name: string; prompt: string }): string {
  if (!skill) return '';
  return [`## Skill: ${skill.name}`, skill.prompt].join('\n\n');
}
```

Run: `npx vitest run server/__tests__/chat-commands.test.ts` → PASS 6/6。

- [ ] **Step 3: chat_summary 列 + 仓库方法（先写失败测试）**

在 `server/__tests__/chat-session-repository.test.ts` 的最后一个 describe 之后追加：

```ts
describe('chatSummary 与 resetChatContext', () => {
  it('updateChatFields 持久化 chatSummary；resetChatContext 清空句柄与摘要但保留模型', () => {
    repo.create(chatSession('c5'));
    repo.updateChatFields('c5', { chatSdkSessionId: 'sdk-1', chatModel: 'gpt-4o', chatSummary: '早期摘要' });
    expect(repo.getById('c5')!.chatSummary).toBe('早期摘要');

    repo.resetChatContext('c5');
    const loaded = repo.getById('c5')!;
    expect(loaded.chatSdkSessionId).toBeUndefined();
    expect(loaded.chatSummary).toBeUndefined();
    expect(loaded.chatModel).toBe('gpt-4o');
  });
});
```

Run: `npx vitest run server/__tests__/chat-session-repository.test.ts` → FAIL（chatSummary 未持久化 / resetChatContext 不存在）。

实现：

1. `shared/types.ts` Session 接口 `chatModel` 之后追加：

```ts
  chatSummary?: string;        // Claude 对话：/compact 生成的摘要（新会话首轮注入后清除）
```

2. `server/db/schema.ts` 迁移区（`chat_model` ALTER 之后）追加：

```ts
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_summary TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
```

3. `server/db/repositories/sessions.ts`：
   - `getById()` 返回对象 `chatModel` 行后追加：

```ts
      chatSummary: (row['chat_summary'] as string) || undefined,
```

   - `updateChatFields` 整体替换为（扩展 chatSummary，语义不变）：

```ts
  updateChatFields(id: string, fields: { chatSdkSessionId?: string; chatModel?: string; chatSummary?: string }): Session | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    this.db.run(
      'UPDATE sessions SET chat_sdk_session_id=?, chat_model=?, chat_summary=?, updated_at=? WHERE id=?',
      [updated.chatSdkSessionId ?? null, updated.chatModel ?? null, updated.chatSummary ?? null, updated.updatedAt, id]
    );
    return updated;
  }
```

   - `updateChatFields` 之后追加：

```ts
  /** /clear：清空 SDK 会话句柄与压缩摘要（保留聊天记录与会话级模型选择） */
  resetChatContext(id: string): void {
    this.updateChatFields(id, { chatSdkSessionId: undefined, chatSummary: undefined });
  }
```

Run: `npx vitest run server/__tests__/chat-session-repository.test.ts` → PASS。

- [ ] **Step 4: ChatTurnConfig.disableTools（agent-manager）**

`server/claude/agent-manager.ts`：
1. `ChatTurnConfig` 接口 `wsChannel` 之前追加一行：

```ts
  disableTools?: boolean;     // /compact 摘要轮禁用工具，避免权限弹窗
```

2. `executeChatTurn` 内 `if (config.resumeSessionId) sdkOptions.resume = config.resumeSessionId;` 之后追加：

```ts
      if (config.disableTools) sdkOptions.tools = [];
```

- [ ] **Step 5: turn-runner 重构（先写失败测试）**

在 `server/__tests__/chat-turn-runner.test.ts` 末尾（现有 describe 内）追加（`makeSession`/`runnerWith`/`flush` 已存在；`runnerWith` 的 fake agentManager 需能捕获 config —— 该 helper 目前是 `(cfg: any) => AsyncGenerator` 形参，可直接捕获）：

```ts
  it('startCompact：resume 旧会话、禁工具，摘要落库、句柄清空、系统消息、状态 idle', async () => {
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
```

Run: `npx vitest run server/__tests__/chat-turn-runner.test.ts` → FAIL（startCompact 不存在等）。

- [ ] **Step 6: 重构 turn-runner.ts（整体替换）**

`server/chat/turn-runner.ts` 整体替换为（将事件循环抽为 `runTurnAsync`，startTurn/startCompact 共用；新增摘要注入与 skill 块）：

```ts
import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { parseMentions, buildReferencedFilesBlock } from './mentions';
import { buildCompactPrompt, buildSkillBlock } from './commands';
import type { ChatTurnConfig, ChatTurnEvent } from '../claude/agent-manager';
import type { Session } from '../../shared/types';

export interface ChatAgentLike {
  executeChatTurn(config: ChatTurnConfig): AsyncGenerator<ChatTurnEvent>;
}

export interface ChatRunnerDeps {
  sessionRepo: SessionRepository;
  usageRepo: UsageRepository;
  // 方法签名（而非属性箭头）以保持对 SessionChannel 的结构兼容（事件参数双变）
  wsChannel?: {
    broadcastToSession(sessionId: string, event: unknown): void;
  };
  agentManager: ChatAgentLike;
}

/**
 * Claude 对话轮次执行器：解析 @引用/skill → 写用户消息 → 流式转发 WS →
 * 落库助手消息与 usage → 状态机 running→idle/error。
 * 另提供 /compact 隐藏摘要轮（startCompact）。
 */
export class ChatTurnRunner {
  private controllers = new Map<string, AbortController>();

  constructor(private deps: ChatRunnerDeps) {}

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** 中断当前轮；返回是否确有运行中的轮被中断 */
  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 发起一轮对话（后台执行，立即返回）。skill 非空时在 prompt 末尾注入 Skill 块。 */
  startTurn(session: Session, content: string, defaultModel?: string, skill?: { name: string; prompt: string }): void {
    if (this.controllers.has(session.id)) return;

    const root = session.workspaces[0]?.path || process.cwd();
    const mentions = parseMentions(content, root);
    const summaryToInject = session.chatSummary && !session.chatSdkSessionId ? session.chatSummary : '';
    const summaryBlock = summaryToInject
      ? ['## Previous Conversation Summary', summaryToInject, '（以上为此前对话的压缩摘要，请基于它继续。）'].join('\n\n')
      : '';
    const prompt = [summaryBlock, content, buildReferencedFilesBlock(mentions.files), buildSkillBlock(skill)]
      .filter(Boolean).join('\n\n');

    this.deps.sessionRepo.addMessage(session.id, null, 'user', content);
    this.deps.sessionRepo.applyFirstMessage(session.id, content);
    const controller = this.beginTurn(session);
    if (!controller) return;

    this.runTurnAsync(session, {
      sessionId: session.id,
      prompt,
      model: session.chatModel || defaultModel,
      resumeSessionId: session.chatSdkSessionId,
      workspaces: session.workspaces,
      abortController: controller,
      wsChannel: this.deps.wsChannel as never,
    }, controller, { persistSdkSession: true, clearSummaryOnSdkSession: !!summaryBlock })
      .then((result) => {
        if (result.content || result.thinking) {
          this.deps.sessionRepo.addMessage(
            session.id, null, 'assistant',
            result.content, result.thinking || undefined,
          );
        }
        this.endTurn(session.id, controller, result.error);
      })
      .catch((err: unknown) => {
        console.error(`[chat] turn crashed for session ${session.id}:`, err);
        this.endTurn(session.id, controller, (err as Error).message);
      });
  }

  /** /compact：隐藏摘要轮 — resume 当前会话生成摘要，存库并重置会话句柄。 */
  startCompact(session: Session, defaultModel?: string): void {
    if (this.controllers.has(session.id)) return;
    if (!session.chatSdkSessionId) {
      this.deps.sessionRepo.addMessage(session.id, null, 'system', '对话为空，无需压缩。');
      return;
    }
    const controller = this.beginTurn(session);
    if (!controller) return;

    this.runTurnAsync(session, {
      sessionId: session.id,
      prompt: buildCompactPrompt(),
      model: session.chatModel || defaultModel,
      resumeSessionId: session.chatSdkSessionId,
      workspaces: session.workspaces,
      abortController: controller,
      wsChannel: this.deps.wsChannel as never,
      disableTools: true,
    }, controller, { persistSdkSession: false, clearSummaryOnSdkSession: false })
      .then((result) => {
        if (result.error && !controller.signal.aborted) {
          this.deps.sessionRepo.addMessage(session.id, null, 'system', '⚠️ 上下文压缩失败，可稍后重试 /compact。');
          this.endTurn(session.id, controller, result.error);
          return;
        }
        if (!controller.signal.aborted) {
          const summary = result.content.trim();
          if (summary) {
            this.deps.sessionRepo.updateChatFields(session.id, {
              chatSdkSessionId: undefined, chatSummary: summary,
            });
            this.deps.sessionRepo.addMessage(
              session.id, null, 'system',
              `📦 上下文已压缩（摘要 ${summary.length} 字），下轮对话将携带摘要。`,
            );
          }
        }
        this.endTurn(session.id, controller, null);
      })
      .catch((err: unknown) => {
        console.error(`[chat] compact crashed for session ${session.id}:`, err);
        this.endTurn(session.id, controller, (err as Error).message);
      });
  }

  // ---- 内部 ----

  /** 占用会话：置 running、广播、注册 AbortController；已占用返回 null */
  private beginTurn(session: Session): AbortController | null {
    if (this.controllers.has(session.id)) return null;
    this.deps.sessionRepo.updateStatus(session.id, 'running');
    this.deps.wsChannel?.broadcastToSession(session.id, {
      type: 'status_change', data: { status: 'running', currentStepIndex: 0 },
    });
    const controller = new AbortController();
    this.controllers.set(session.id, controller);
    return controller;
  }

  /** 释放会话：状态机（abort→idle、error(非 abort)→error、其余 idle）+ 广播 */
  private endTurn(sessionId: string, controller: AbortController, error: string | null): void {
    this.controllers.delete(sessionId);
    const aborted = controller.signal.aborted;
    const status = error && !aborted ? 'error' : 'idle';
    this.deps.sessionRepo.updateStatus(sessionId, status);
    this.deps.wsChannel?.broadcastToSession(sessionId, {
      type: 'status_change', data: { status, currentStepIndex: 0 },
    });
  }

  /** 驱动一次 SDK 轮次：事件转发 WS、累积文本、usage 落库；返回累积结果 */
  private async runTurnAsync(
    session: Session,
    config: ChatTurnConfig,
    controller: AbortController,
    opts: { persistSdkSession: boolean; clearSummaryOnSdkSession: boolean },
  ): Promise<{ content: string; thinking: string; error: string | null }> {
    const accumulated = { content: '', thinking: '' };
    let turnError: string | null = null;
    try {
      for await (const event of this.deps.agentManager.executeChatTurn(config)) {
        switch (event.type) {
          case 'sdk_session':
            if (opts.persistSdkSession) {
              this.deps.sessionRepo.updateChatFields(session.id, { chatSdkSessionId: event.sdkSessionId });
            }
            if (opts.clearSummaryOnSdkSession) {
              this.deps.sessionRepo.updateChatFields(session.id, { chatSummary: undefined });
            }
            break;
          case 'thinking_stream':
            if (!event.done) accumulated.thinking += event.content;
            this.deps.wsChannel?.broadcastToSession(session.id, {
              type: 'thinking_delta', data: { content: event.content, done: event.done },
            });
            break;
          case 'ai_stream':
            if (!event.done) accumulated.content += event.content;
            this.deps.wsChannel?.broadcastToSession(session.id, {
              type: 'ai_message', data: { content: event.content, done: event.done },
            });
            break;
          case 'tool_use':
            this.deps.wsChannel?.broadcastToSession(session.id, {
              type: 'tool_use', data: { toolName: event.toolName, input: event.input },
            });
            break;
          case 'usage':
            this.deps.usageRepo.add({
              sessionId: session.id,
              model: event.model,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
              cacheCreationTokens: event.usage.cacheCreationTokens,
            });
            break;
          case 'turn_error':
            turnError = event.error;
            break;
        }
      }
    } catch (err) {
      turnError = (err as Error).message;
    }
    return { content: accumulated.content, thinking: accumulated.thinking, error: turnError };
  }
}
```

Run: `npx vitest run server/__tests__/chat-turn-runner.test.ts` → 全部 PASS（含既有 6 例——行为不变：stop 保留部分内容、error 状态、WS 广播序列、模型优先级、首条消息命名）。

- [ ] **Step 7: 路由命令分发（先追加失败用例）**

在 `server/__tests__/chat-routes.test.ts` 的 `describe('chat messages/stop')` 内追加：

```ts
  it('/clear：202 + 系统消息 + 清空会话句柄（无供应商也可用）', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }], model: 'm' });
    const id = created.body.data.id;
    // 直接种 SDK 会话句柄（绕过真实轮次）
    new (require('../db/repositories/sessions').SessionRepository)(dbHelper)
      .updateChatFields(id, { chatSdkSessionId: 'sdk-x', chatSummary: '旧摘要' });

    const { status } = await req('POST', `/api/chat/${id}/messages`, { content: '/clear' });
    expect(status).toBe(202);

    const repo = new (require('../db/repositories/sessions').SessionRepository)(dbHelper);
    const loaded = repo.getById(id)!;
    expect(loaded.chatSdkSessionId).toBeUndefined();
    expect(loaded.chatSummary).toBeUndefined();
    expect(loaded.chatModel).toBe('m'); // 模型选择保留
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'system'`,
    );
    expect(sysMsgs.some(m => String(m['content']).includes('上下文已清理'))).toBe(true);
    // 命令文本本身不入库
    const userMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'user'`,
    );
    expect(userMsgs).toHaveLength(0);
  });

  it('/compact：无 SDK 会话 → 202 + 「对话为空，无需压缩」', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { status } = await req('POST', `/api/chat/${id}/messages`, { content: '/compact' });
    expect(status).toBe(202);
    const sysMsgs = dbHelper.all<Record<string, unknown>>(
      `SELECT * FROM messages WHERE session_id = '${id}' AND role = 'system'`,
    );
    expect(sysMsgs.some(m => String(m['content']).includes('对话为空'))).toBe(true);
  });

  it('未知命令 400', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { status, body } = await req('POST', `/api/chat/${id}/messages`, { content: '/nope' });
    expect(status).toBe(400);
    expect(body.error).toContain('未知命令 /nope');
  });

  it('/clear：运行中 409', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    // 借用该 describe 顶部既有的 hangingRunner（Task 7 已注入的测试 runner）触发运行态
    // 若 hangingRunner 在其它用例内声明，则在本用例内重建一个最小挂起 runner：
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { SessionRepository: SR } = require('../db/repositories/sessions');
    const { UsageRepository: UR } = require('../db/repositories/usage');
    const { ChatTurnRunner: CTR } = require('../chat/turn-runner');
    const hanging = new CTR({
      sessionRepo: new SR(dbHelper), usageRepo: new UR(dbHelper),
      agentManager: { async *executeChatTurn(cfg: any): AsyncGenerator<any> {
        yield { type: 'ai_stream', content: 'x', done: false };
        await gate;
        yield { type: 'ai_stream', content: '', done: true };
      } },
    });
    const appX = express();
    appX.use(express.json());
    appX.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: hanging as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
    }));
    const serverX = http.createServer(appX);
    await new Promise<void>((resolve) => serverX.listen(0, resolve));
    const baseX = `http://127.0.0.1:${(serverX.address() as any).port}`;

    await fetch(`${baseX}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    await new Promise(r => setTimeout(r, 30));

    const cmd = await fetch(`${baseX}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/clear' }),
    });
    expect(cmd.status).toBe(409);

    release();
    await new Promise(r => setTimeout(r, 30));
    serverX.close();
  });
```

注意：把该文件顶部已有的 `require(...)` 内联导入替换为正常顶部 import（`SessionRepository`、`UsageRepository`、`ChatTurnRunner` 若已存在则复用；上例中保留 `require` 写法亦可，但顶部 import 更整洁 —— 以文件现状为准，保持一致即可）。

Run: `npx vitest run server/__tests__/chat-routes.test.ts` → 新用例部分 FAIL（命令未分发）。

- [ ] **Step 8: 路由实现命令分发**

`server/routes/chat.ts`：
1. 顶部追加 `import { parseChatCommand } from '../chat/commands';`
2. `POST /:id/messages` 路由整体替换为（在现有守卫间插入命令分发；普通消息路径行为不变）：

```ts
  // 发送一轮消息（后台执行，流式经 WS 推送）；/ 开头为命令（服务端分发）
  router.post('/:id/messages', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const { content } = req.body || {};
      if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });

      const command = parseChatCommand(content.trim());
      if (command && runner.isRunning(session.id)) {
        return res.status(409).json({ success: false, error: '当前回复生成中，请稍候或先停止' });
      }
      if (command?.type === 'clear') {
        sessionRepo.resetChatContext(session.id);
        sessionRepo.addMessage(session.id, null, 'system', '🧹 上下文已清理，模型将重新开始（聊天记录保留）。');
        deps.wsChannel?.broadcastToSession(session.id, {
          type: 'status_change', data: { status: 'idle', currentStepIndex: 0 },
        });
        return res.status(202).json({ success: true });
      }
      if (command?.type === 'compact') {
        if (!requireActiveProvider(res)) return;
        runner.startCompact(session, deps.providerRepo?.getActive()?.model);
        return res.status(202).json({ success: true });
      }
      if (command) {
        // skill 命令在本任务暂不支持（Task 3 接资源仓库），统一按未知命令提示
        return res.status(400).json({ success: false, error: `未知命令 /${command.name}，可用：/clear、/compact 或已启用的 skill` });
      }

      if (!requireActiveProvider(res)) return;
      if (runner.isRunning(session.id)) {
        return res.status(409).json({ success: false, error: '当前回复生成中，请稍候或先停止' });
      }
      const defaultModel = deps.providerRepo?.getActive()?.model;
      runner.startTurn(session, content.trim(), defaultModel);
      res.status(202).json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
```

Run: `npx vitest run server/__tests__/chat-routes.test.ts` → 全部 PASS。

- [ ] **Step 9: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿（预计 195 + 6 + 5 + 4 + 1 ≈ 211，以实际为准）。

```bash
git add server/chat/commands.ts server/chat/turn-runner.ts server/routes/chat.ts server/claude/agent-manager.ts server/db/schema.ts server/db/repositories/sessions.ts shared/types.ts server/__tests__/chat-commands.test.ts server/__tests__/chat-session-repository.test.ts server/__tests__/chat-turn-runner.test.ts server/__tests__/chat-routes.test.ts
git commit -m "feat: 对话 / 命令——/clear 重置上下文 + /compact 隐藏摘要轮（chat_summary 列 + 命令分发）"
```

---

### Task 3: skill 命令接线 + 前端 / 候选菜单

**Files:**
- Modify: `server/routes/chat.ts`（deps 加 resourceRepo；skill 分支）
- Modify: `server/__tests__/chat-routes.test.ts`（skill 命中/未知 2 例）
- Modify: `server/app.ts`（传入 resourceRepo）
- Modify: `src/pages/ChatSession.tsx`（双前缀 Mentions + 命令候选）

**Interfaces:**
- Consumes: Task 2 的 `parseChatCommand`（`{type:'skill'; name}`）、`startTurn` 第 4 参、`ResourceRepository.list(filters)`、前端 `resourceApi.list(type)`、`Resource.enabled/description/config`。
- Produces: skill 命令端到端可用；前端 `/` 下拉含内置命令与已启用 skill。

- [ ] **Step 1: skill 命中/未知用例（先写失败测试）**

在 `server/__tests__/chat-routes.test.ts` 的 `describe('chat messages/stop')` 内追加（用 spy runner 断言 startTurn 收到 skill 参数）：

```ts
  it('/skill 命令：命中已启用 skill → 202 且 startTurn 收到 skill 参数', async () => {
    // 准备资源仓库 + 一个已启用 skill
    const { ResourceRepository: RR } = require('../db/repositories/resources');
    const resourceRepo = new RR(dbHelper);
    resourceRepo.create({
      id: 'skill-cr', type: 'skill', name: 'code-review', description: '代码审查',
      version: '1.0.0', source: 'manual', config: { prompt: '审查代码时逐文件检查' },
      enabled: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    const startTurnSpy = vi.fn();
    const spyRunner = { isRunning: () => false, startTurn: startTurnSpy, stop: () => false };
    const appY = express();
    appY.use(express.json());
    appY.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: spyRunner as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
      resourceRepo,
    }));
    const serverY = http.createServer(appY);
    await new Promise<void>((resolve) => serverY.listen(0, resolve));
    const baseY = `http://127.0.0.1:${(serverY.address() as any).port}`;

    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;

    const { status } = await fetch(`${baseY}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/code-review 重点看登录模块' }),
    }).then(r => r.status).then(s => ({ status: s }));
    expect(status).toBe(202);
    expect(startTurnSpy).toHaveBeenCalledTimes(1);
    const [, content, , skill] = startTurnSpy.mock.calls[0];
    expect(content).toBe('/code-review 重点看登录模块');
    expect(skill).toEqual({ name: 'code-review', prompt: '审查代码时逐文件检查' });
    serverY.close();
  });

  it('/skill 命令：未命中（含禁用）→ 400 未知命令', async () => {
    const { ResourceRepository: RR } = require('../db/repositories/resources');
    const resourceRepo = new RR(dbHelper);
    resourceRepo.create({
      id: 'skill-off', type: 'skill', name: 'disabled-skill', description: '',
      version: '1.0.0', source: 'manual', config: { prompt: 'x' },
      enabled: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });

    const spyRunner = { isRunning: () => false, startTurn: () => {}, stop: () => false };
    const appZ = express();
    appZ.use(express.json());
    appZ.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: spyRunner as never,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
      resourceRepo,
    }));
    const serverZ = http.createServer(appZ);
    await new Promise<void>((resolve) => serverZ.listen(0, resolve));
    const baseZ = `http://127.0.0.1:${(serverZ.address() as any).port}`;

    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;

    const res = await fetch(`${baseZ}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '/disabled-skill' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('未知命令 /disabled-skill');
    serverZ.close();
  });
```

注意：测试文件顶部需补 `import { vi } from 'vitest'`（或并入现有 vitest import）；`ResourceRepository.create` 的入参形状以 `server/db/repositories/resources.ts` 的 create 实现为准（若必填字段有差异——如 source 枚举——按其类型修正上述字面量）。先运行确认失败再实现。

Run: `npx vitest run server/__tests__/chat-routes.test.ts` → 新 2 例 FAIL（deps 无 resourceRepo / skill 走 400）。

- [ ] **Step 2: routes 接线 skill 分支**

`server/routes/chat.ts`：
1. imports 追加：

```ts
import { ResourceRepository } from '../db/repositories/resources';
import type { SkillConfig } from '../../shared/types';
```

2. `ChatRouteDeps` 追加字段（`providerRepo?` 之后）：

```ts
  /** skill 命令解析用（Task 3） */
  resourceRepo?: ResourceRepository;
```

3. 将 Task 2 的 `if (command) { ...未知命令 400... }` 块整体替换为：

```ts
      if (command.type === 'skill') {
        const skills = deps.resourceRepo?.list({ type: 'skill', enabled: true }) ?? [];
        const skill = skills.find(r => r.name === command.name);
        if (!skill) {
          return res.status(400).json({ success: false, error: `未知命令 /${command.name}，可用：/clear、/compact 或已启用的 skill` });
        }
        if (!requireActiveProvider(res)) return;
        if (runner.isRunning(session.id)) {
          return res.status(409).json({ success: false, error: '当前回复生成中，请稍候或先停止' });
        }
        const skillConfig = skill.config as SkillConfig;
        const defaultModel = deps.providerRepo?.getActive()?.model;
        runner.startTurn(session, content.trim(), defaultModel, { name: skill.name, prompt: skillConfig.prompt || '' });
        return res.status(202).json({ success: true });
      }
      return res.status(400).json({ success: false, error: `未知命令 /${(command as { name?: string }).name ?? ''}，可用：/clear、/compact 或已启用的 skill` });
```

（最后的 return 为穷尽性兜底，正常不可达。）

4. `server/app.ts`：chat 挂载追加 `resourceRepo`（该文件 dbHelper 分支已有 `const resourceRepo = new ResourceRepository(options.dbHelper);`，直接传入）：

```ts
    app.use('/api/chat', createChatRoutes({
      dbHelper: options.dbHelper,
      providerRepo,
      wsChannel: options.wsChannel,
      resourceRepo,
    }));
```

Run: `npx vitest run server/__tests__/chat-routes.test.ts` → 全部 PASS。
若 `ResourceRepository.list` 不支持 `enabled` 过滤（检查 `server/db/repositories/resources.ts` 的 `ListFilters`），改为 `list({ type: 'skill' })` 后在 find 条件中加 `&& r.enabled`，并在报告中注明。

- [ ] **Step 3: 前端 / 候选菜单**

`src/pages/ChatSession.tsx`：
1. imports 追加：

```tsx
import { resourceApi } from '../api/resources';
import type { Resource, SkillConfig } from '../types';
```

2. 组件 state 区（`fileOptions` 之后）追加：

```tsx
  const [skills, setSkills] = useState<Resource[]>([]);
  const [slashMode, setSlashMode] = useState(false);
```

3. 模型候选 useEffect 之后追加（skill 列表拉取一次）：

```tsx
  useEffect(() => {
    resourceApi.list('skill').then(list => setSkills(list.filter(s => s.enabled))).catch(() => {});
  }, []);
```

4. `thinkingPendingIds` 的 useMemo 之前追加命令候选：

```tsx
  const commandOptions = useMemo(() => [
    { value: 'clear', label: <div>🧹 <b>/clear</b> 清理上下文（重置模型记忆，保留聊天记录）</div> },
    { value: 'compact', label: <div>📦 <b>/compact</b> 压缩上下文（生成摘要后重新开始）</div> },
    ...skills.map(s => (
      { value: s.name, label: <div>⚡ <b>/{s.name}</b>{s.description ? ` ${s.description}` : ''}</div> }
    )),
  ], [skills]);
```

5. `<Mentions>` 属性修改（约 215-218 行）：

```tsx
            prefix={['@', '/']}
            options={slashMode ? commandOptions : fileOptions}
            onSearch={(_search, prefix) => setSlashMode(prefix === '/')}
```

（替换原有 `prefix="@"` 与 `options={fileOptions}` 两行；`onPressEnter`/`value`/`onChange` 等其余属性不动。）

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit && npm run build` → 全绿。

```bash
git add server/routes/chat.ts server/app.ts server/__tests__/chat-routes.test.ts src/pages/ChatSession.tsx
git commit -m "feat: skill 命令注入 + 对话输入 / 双前缀候选菜单（内置命令与已启用 skill）"
```

---

## 计划自审记录

1. **Spec 覆盖**：§1 气泡（Task 1）；§2.1 解析与分发（Task 2 Step 1/2/7/8）；§2.2 /clear、/compact（Task 2，含禁工具与失败路径）；§2.3 摘要注入与清除（Task 2 Step 5/6）；§2.4 skill 命令（Task 2 buildSkillBlock/参数位 + Task 3 接线）；§2.5 前端（Task 3 Step 3）；§2.6 迁移与类型（Task 2 Step 3）；§2.7 测试（各任务）。无缺口。
2. **占位符**：无 TBD/TODO；两处「以文件现状为准」的指示均为对既有测试文件导入风格的适配说明，非实现占位。
3. **类型一致性**：`ChatCommand`/`buildSkillBlock`/`startCompact`/`updateChatFields` 扩展签名/`Session.chatSummary`/`ChatTurnConfig.disableTools` 在定义与消费处一致；`startTurn` 第 4 参在 Task 2 定义、Task 3 消费。Task 2 的路由 400 分支在 Task 3 被 skill 分支替换 —— 两任务的替换边界已在 Step 中写明。
4. **行为回归风险**：turn-runner 重构保持既有 6 例语义（stop 保留部分内容、abort→idle、error 状态、WS 广播序列、模型优先级、首条消息命名）——Step 6 明确要求全部继续通过。
