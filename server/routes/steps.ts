import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../db/helper';
import { StepRepository } from '../db/repositories/steps';
import type { StepTemplate } from '../../shared/types';

export function createStepRoutes(dbHelper: DbHelper): Router {
  const router = Router();
  const repo = new StepRepository(dbHelper);

  // List
  router.get('/', (req: Request, res: Response) => {
    try {
      const { category } = req.query;
      const steps = repo.list(category ? { category: category as string } : undefined);
      res.json({ success: true, data: steps });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Get by id
  router.get('/:id', (req: Request, res: Response) => {
    try {
      const step = repo.getById(req.params.id);
      if (!step) return res.status(404).json({ success: false, error: 'Step not found' });
      res.json({ success: true, data: step });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Create
  router.post('/', (req: Request, res: Response) => {
    try {
      const { name, category, description, systemPrompt, interactionMode, ...rest } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      if (!systemPrompt || typeof systemPrompt !== 'string') {
        return res.status(400).json({ success: false, error: 'systemPrompt is required' });
      }
      const mode = interactionMode || 'auto';
      if (!['auto', 'confirm-each', 'auto-with-review'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'Invalid interactionMode' });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      const step: StepTemplate = {
        id,
        name: name.trim(),
        category: category || '工具',
        description: description || '',
        systemPrompt,
        model: rest.model,
        maxTokens: rest.maxTokens,
        tools: rest.tools || [],
        agentId: rest.agentId,
        skillIds: rest.skillIds || [],
        mcpServerIds: rest.mcpServerIds || [],
        resourceOverrides: rest.resourceOverrides,
        interactionMode: mode,
        autoAdvance: rest.autoAdvance !== false,
        pauseForQuestions: rest.pauseForQuestions || false,
        collectActionItems: rest.collectActionItems || false,
        loopEnabled: rest.loopEnabled || false,
        defaultLoopConfig: rest.defaultLoopConfig,
        inputSchema: rest.inputSchema,
        outputFormat: rest.outputFormat || 'markdown',
        outputTemplate: rest.outputTemplate,
      };

      const created = repo.create(step);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Update
  router.put('/:id', (req: Request, res: Response) => {
    try {
      const updates = { ...req.body };
      delete updates.id;
      const updated = repo.update(req.params.id, updates);
      if (!updated) return res.status(404).json({ success: false, error: 'Step not found' });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Delete
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const deleted = repo.delete(req.params.id);
      if (!deleted) return res.status(404).json({ success: false, error: 'Step not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
