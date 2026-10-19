import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { PipelineRepository } from '../db/repositories/pipelines';
import { ResourceRepository } from '../db/repositories/resources';
import { StepRepository } from '../db/repositories/steps';
import { ProviderRepository } from '../db/repositories/providers';
import { UsageRepository } from '../db/repositories/usage';
import { PrecheckEngine } from '../engine/precheck';
import { PipelineExecutor } from '../engine/executor';
import { SessionChannel } from '../ws/session-channel';
import { cancelSessionPermissions } from '../ws/permission-store';
import { config } from '../config';
import type { Session, SessionStep } from '../../shared/types';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';

export interface SessionRouteDeps {
  wsChannel?: SessionChannel;
  resourceRepo: ResourceRepository;
  stepRepo: StepRepository;
  providerRepo?: ProviderRepository;
  /** Test seam: build the step executor generator instead of the real one */
  executorFactory?: (session: Session) => AsyncGenerator<unknown>;
}

export function createSessionRoutes(dbHelper: DbHelper, deps?: SessionRouteDeps): Router {
  const router = Router();
  const sessionRepo = new SessionRepository(dbHelper);
  const pipelineRepo = new PipelineRepository(dbHelper);
  const precheck = new PrecheckEngine();

  // Track running executors per session (for pause/cancel)
  const runningExecutors = new Map<string, AsyncGenerator>();

  const isChatSession = (s: Session) => s.pipelineId === BUILTIN_CHAT_PIPELINE_ID;

  /** 需要已激活供应商的路由守卫：未配置时返回 400 */
  function requireActiveProvider(res: Response): boolean {
    if (deps?.providerRepo && !deps.providerRepo.getActive()) {
      res.status(400).json({ success: false, error: '未配置生效的大模型供应商，请在「模型配置」页激活' });
      return false;
    }
    return true;
  }

  /** Launch executor in background and drive it to completion */
  function launchExecutor(session: Session): void {
    if (!deps?.wsChannel || !deps?.resourceRepo || !deps?.stepRepo) return;

    const gen = deps.executorFactory
      ? deps.executorFactory(session)
      : new PipelineExecutor(sessionRepo, deps.resourceRepo, deps.stepRepo, new UsageRepository(dbHelper))
          .execute(session, deps.wsChannel, config.outputDir, {
            defaultModel: deps.providerRepo?.getActive()?.model,
          });

    runningExecutors.set(session.id, gen);
    (async () => {
      try {
        for await (const _event of gen) { /* events forwarded via WebSocket inside */ }
        console.log(`[executor] Session ${session.id} completed`);
      } catch (err) {
        const errMsg = (err as Error).message;
        console.error(`[executor] Session ${session.id} crashed:`, errMsg);
        console.error((err as Error).stack);
        sessionRepo.updateStatus(session.id, 'error');
        deps?.wsChannel?.broadcastToSession(session.id, {
          type: 'status_change',
          data: { status: 'error', currentStepIndex: session.currentStepIndex },
        });
      } finally {
        runningExecutors.delete(session.id);
      }
    })();
  }

  // List
  router.get('/', (req: Request, res: Response) => {
    try {
      const sessions = sessionRepo.list({ status: req.query.status as string | undefined });
      res.json({ success: true, data: sessions });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Get by id
  router.get('/:id', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      res.json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Create
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { pipelineId, name, requirement, workspaces, stepOverrides } = req.body;
      if (!pipelineId || !name?.trim() || !requirement?.trim()) {
        return res.status(400).json({ success: false, error: 'pipelineId, name, requirement are required' });
      }
      if (!workspaces || workspaces.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one workspace is required' });
      }

      const pipeline = pipelineRepo.getById(pipelineId);
      if (!pipeline) return res.status(404).json({ success: false, error: 'Pipeline not found' });

      const id = uuidv4(); const now = new Date().toISOString();
      const steps: SessionStep[] = pipeline.steps.map(s => ({
        templateId: s.templateId,
        stepName: deps?.stepRepo.getById(s.templateId)?.name || s.templateId,
        status: 'pending' as const, retryCount: 0,
      }));

      const session: Session = {
        id, pipelineId, pipelineSnapshot: pipeline,
        name: name.trim(), requirement: requirement.trim(),
        status: 'idle', workspaces,
        currentStepIndex: 0, steps,
        stepOverrides: stepOverrides || {},
        createdAt: now, updatedAt: now,
      };

      sessionRepo.create(session);
      res.status(201).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Precheck
  router.post('/:id/precheck', async (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (isChatSession(session)) {
        return res.status(400).json({ success: false, error: '对话会话请在「Claude 对话」页使用' });
      }

      const environment = await precheck.run(session.workspaces);
      const updated = sessionRepo.updateStatus(session.id, 'idle', { environment });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Start — launches the pipeline executor as a background async job
  router.post('/:id/start', async (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (isChatSession(session)) {
        return res.status(400).json({ success: false, error: '对话会话请在「Claude 对话」页使用' });
      }

      // Guard against double-start: an executor may already be running
      if (runningExecutors.has(session.id) || session.status === 'running') {
        return res.status(409).json({ success: false, error: 'Session is already running' });
      }

      if (!requireActiveProvider(res)) return;

      // Set status to running and respond immediately
      sessionRepo.updateStatus(session.id, 'running');
      const updated = sessionRepo.getById(session.id)!;
      res.json({ success: true, data: updated });

      // Launch executor in background
      launchExecutor(updated);
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Cancel — stop the running executor if active
  router.post('/:id/cancel', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      // Stop background executor if running
      const gen = runningExecutors.get(session.id);
      if (gen) {
        gen.return(undefined).catch(() => {});
        runningExecutors.delete(session.id);
      }
      // Release any permission requests awaiting user confirmation
      cancelSessionPermissions(session.id);
      const updated = sessionRepo.updateStatus(session.id, 'cancelled');
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Pause — flip status; the running executor keeps going and checks status
  router.post('/:id/pause', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      const updated = sessionRepo.updateStatus(session.id, 'paused');
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Resume — continue a waiting/paused session from currentStepIndex
  router.post('/:id/resume', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (isChatSession(session)) {
        return res.status(400).json({ success: false, error: '对话会话请在「Claude 对话」页使用' });
      }

      if (!requireActiveProvider(res)) return;

      const updated = sessionRepo.updateStatus(session.id, 'running')!;

      // After a waiting_confirm pause the executor is gone — relaunch it
      // from the stored currentStepIndex unless it is already running.
      if (!runningExecutors.has(session.id) && updated.currentStepIndex < updated.steps.length) {
        launchExecutor(updated);
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/:id/retry', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (isChatSession(session)) {
        return res.status(400).json({ success: false, error: '对话会话请在「Claude 对话」页使用' });
      }
      const stepIdx = session.currentStepIndex;

      // Stop any existing executor for this session
      const existing = runningExecutors.get(session.id);
      if (existing) {
        existing.return(undefined).catch(() => {});
        runningExecutors.delete(session.id);
      }
      // Release permission requests owned by the stopped executor
      cancelSessionPermissions(session.id);

      if (!requireActiveProvider(res)) return;

      if (stepIdx < session.steps.length) {
        sessionRepo.updateStatus(session.id, 'running');
        sessionRepo.updateStepStatus(session.id, stepIdx, 'running', {
          retryCount: session.steps[stepIdx].retryCount + 1,
          errorMessage: undefined,
          outputPath: undefined,
        });
        const updated = sessionRepo.getById(session.id)!;
        res.json({ success: true, data: updated });

        // Launch executor in background
        launchExecutor(updated);
      } else {
        res.json({ success: true, data: session });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/:id/clone', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (isChatSession(session)) {
        return res.status(400).json({ success: false, error: '对话会话请在「Claude 对话」页使用' });
      }
      const id = uuidv4(); const now = new Date().toISOString();
      const cloned: Session = {
        ...session, id, name: `${session.name} (副本)`, status: 'idle',
        currentStepIndex: 0, createdAt: now, updatedAt: now,
        steps: session.steps.map(s => ({ ...s, status: 'pending' as const, startedAt: undefined, completedAt: undefined, outputPath: undefined, retryCount: 0 })),
      };
      sessionRepo.create(cloned);
      res.status(201).json({ success: true, data: cloned });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Delete — 只清除会话相关的数据库记录，不触碰磁盘上的项目文件
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
      if (runningExecutors.has(session.id) || session.status === 'running') {
        return res.status(409).json({ success: false, error: '会话正在运行，请先取消再删除' });
      }
      // Release any permission requests awaiting user confirmation
      cancelSessionPermissions(session.id);
      sessionRepo.deleteCascade(session.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Action items
  router.get('/:id/action-items', (req: Request, res: Response) => {
    try {
      const items = sessionRepo.getActionItems(req.params.id);
      res.json({ success: true, data: items });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Messages
  router.get('/:id/messages', (req: Request, res: Response) => {
    try {
      const rows = dbHelper.all<Record<string, unknown>>(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at', [req.params.id]
      );
      res.json({ success: true, data: rows.map(r => ({
        id: r['id'], sessionId: r['session_id'], stepId: r['step_id'],
        role: r['role'], content: r['content'],
        thinking: r['thinking_json'] ? JSON.parse(r['thinking_json'] as string) : undefined,
        toolCalls: r['tool_calls_json'] ? JSON.parse(r['tool_calls_json'] as string) : undefined,
        createdAt: r['created_at'],
      })) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/:id/messages', (req: Request, res: Response) => {
    try {
      const { content, stepId, role, thinking } = req.body;
      if (!content) return res.status(400).json({ success: false, error: 'content is required' });
      const effectiveRole = role || 'user';
      const id = uuidv4();
      dbHelper.run(
        `INSERT INTO messages (id, session_id, step_id, role, content, thinking_json) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.params.id, stepId || null, effectiveRole, content,
         thinking ? JSON.stringify(thinking) : null]
      );
      res.status(201).json({ success: true, data: {
        id, sessionId: req.params.id, stepId, role: effectiveRole, content, thinking,
        createdAt: new Date().toISOString(),
      }});
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
