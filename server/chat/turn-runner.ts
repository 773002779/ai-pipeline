import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { parseMentions, buildReferencedFilesBlock } from './mentions';
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
 * Claude 对话轮次执行器：解析 @引用 → 写用户消息 → 流式转发 WS →
 * 落库助手消息与 usage → 状态机 running→idle/error。
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

  /** 发起一轮对话（后台执行，立即返回） */
  startTurn(session: Session, content: string, defaultModel?: string): void {
    if (this.controllers.has(session.id)) return;

    const root = session.workspaces[0]?.path || process.cwd();
    const mentions = parseMentions(content, root);
    const prompt = [content, buildReferencedFilesBlock(mentions.files)].filter(Boolean).join('\n\n');

    this.deps.sessionRepo.addMessage(session.id, null, 'user', content);
    this.deps.sessionRepo.applyFirstMessage(session.id, content);
    this.deps.sessionRepo.updateStatus(session.id, 'running');
    this.deps.wsChannel?.broadcastToSession(session.id, {
      type: 'status_change', data: { status: 'running', currentStepIndex: 0 },
    });

    const controller = new AbortController();
    this.controllers.set(session.id, controller);

    const accumulated = { content: '', thinking: '' };

    (async () => {
      let turnError: string | null = null;
      try {
        for await (const event of this.deps.agentManager.executeChatTurn({
          sessionId: session.id,
          prompt,
          model: session.chatModel || defaultModel,
          resumeSessionId: session.chatSdkSessionId,
          workspaces: session.workspaces,
          abortController: controller,
          wsChannel: this.deps.wsChannel as never,
        })) {
          switch (event.type) {
            case 'sdk_session':
              this.deps.sessionRepo.updateChatFields(session.id, { chatSdkSessionId: event.sdkSessionId });
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
      } finally {
        this.controllers.delete(session.id);
        if (accumulated.content || accumulated.thinking) {
          this.deps.sessionRepo.addMessage(
            session.id, null, 'assistant',
            accumulated.content, accumulated.thinking || undefined,
          );
        }
        const aborted = controller.signal.aborted;
        const status = turnError && !aborted ? 'error' : 'idle';
        this.deps.sessionRepo.updateStatus(session.id, status);
        this.deps.wsChannel?.broadcastToSession(session.id, {
          type: 'status_change', data: { status, currentStepIndex: 0 },
        });
      }
    })().catch((err: unknown) => {
      console.error(`[chat] turn crashed for session ${session.id}:`, err);
    });
  }
}
