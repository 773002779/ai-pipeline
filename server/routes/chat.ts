import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SessionRepository } from '../db/repositories/sessions';
import { ProviderRepository } from '../db/repositories/providers';
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { DbHelper } from '../db/helper';
import type { Session } from '../../shared/types';

export interface ChatRouteDeps {
  dbHelper: DbHelper;
  providerRepo?: ProviderRepository;
}

export function createChatRoutes(deps: ChatRouteDeps): Router {
  const router = Router();
  const sessionRepo = new SessionRepository(deps.dbHelper);
  const builtinPipeline = ensureBuiltinChatPipeline(deps.dbHelper);

  function requireActiveProvider(res: Response): boolean {
    if (deps.providerRepo && !deps.providerRepo.getActive()) {
      res.status(400).json({ success: false, error: '未配置生效的大模型供应商，请在「模型配置」页激活' });
      return false;
    }
    return true;
  }

  function isChatSession(s: Session | null): s is Session {
    return !!s && s.pipelineId === BUILTIN_CHAT_PIPELINE_ID;
  }

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

  return router;
}
