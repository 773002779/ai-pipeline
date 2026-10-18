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
