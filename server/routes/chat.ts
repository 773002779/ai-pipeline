import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SessionRepository } from '../db/repositories/sessions';
import { ProviderRepository } from '../db/repositories/providers';
import { UsageRepository } from '../db/repositories/usage';
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';
import { parseChatCommand } from '../chat/commands';
import { ChatTurnRunner } from '../chat/turn-runner';
import type { ChatAgentLike } from '../chat/turn-runner';
import { ClaudeAgentManager } from '../claude/agent-manager';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { DbHelper } from '../db/helper';
import type { SessionChannel } from '../ws/session-channel';
import type { Session } from '../../shared/types';

export interface ChatRouteDeps {
  dbHelper: DbHelper;
  providerRepo?: ProviderRepository;
  wsChannel?: SessionChannel;
  agentManager?: ChatAgentLike;
  runner?: ChatTurnRunner;
}

export function createChatRoutes(deps: ChatRouteDeps): Router {
  const router = Router();
  const sessionRepo = new SessionRepository(deps.dbHelper);
  const builtinPipeline = ensureBuiltinChatPipeline(deps.dbHelper);

  function requireActiveProvider(res: Response): boolean {
    if (!deps.providerRepo?.getActive()) {
      res.status(400).json({ success: false, error: '未配置生效的大模型供应商，请在「模型配置」页激活' });
      return false;
    }
    return true;
  }

  function isChatSession(s: Session | null): s is Session {
    return !!s && s.pipelineId === BUILTIN_CHAT_PIPELINE_ID;
  }

  const runner = deps.runner ?? new ChatTurnRunner({
    sessionRepo,
    usageRepo: new UsageRepository(deps.dbHelper),
    wsChannel: deps.wsChannel,
    agentManager: deps.agentManager ?? new ClaudeAgentManager(),
  });

  // 创建对话
  router.post('/sessions', (req: Request, res: Response) => {
    try {
      const { workspaces, model } = req.body || {};
      if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces[0]?.path) {
        return res.status(400).json({ success: false, error: 'workspaces 至少需要一项（含 path）' });
      }
      const now = new Date().toISOString();
      const session: Session = {
        id: uuidv4(),
        pipelineId: BUILTIN_CHAT_PIPELINE_ID,
        pipelineSnapshot: builtinPipeline,
        name: '新对话',
        requirement: '',
        status: 'idle',
        workspaces,
        currentStepIndex: 0,
        steps: [],
        chatModel: model || undefined,
        createdAt: now,
        updatedAt: now,
      };
      sessionRepo.create(session);
      res.status(201).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 对话列表
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: sessionRepo.listByPipeline(BUILTIN_CHAT_PIPELINE_ID) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 更新会话级模型（对后续轮次生效）
  router.put('/:id/model', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const { model } = req.body || {};
      const updated = sessionRepo.updateChatFields(session.id, { chatModel: model || undefined });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 删除对话（级联消息/用量/白名单等）
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      sessionRepo.deleteCascade(session.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

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
        // 无 SDK 会话时是纯 no-op（无需模型），不要求已配置供应商
        if (session.chatSdkSessionId && !requireActiveProvider(res)) return;
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

  // 停止当前轮
  router.post('/:id/stop', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const stopped = runner.stop(session.id);
      res.json({ success: true, data: { stopped } });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
