import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../db/helper';
import { PipelineRepository } from '../db/repositories/pipelines';
import type { Pipeline } from '../../shared/types';

export function createPipelineRoutes(dbHelper: DbHelper): Router {
  const router = Router();
  const repo = new PipelineRepository(dbHelper);

  router.get('/', (_req: Request, res: Response) => {
    try {
      const pipelines = repo.list();
      res.json({ success: true, data: pipelines });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    try {
      const pipeline = repo.getById(req.params.id);
      if (!pipeline) return res.status(404).json({ success: false, error: 'Pipeline not found' });
      res.json({ success: true, data: pipeline });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const { name, description, steps } = req.body;
      if (!name?.trim()) return res.status(400).json({ success: false, error: 'Name is required' });

      const id = uuidv4(); const now = new Date().toISOString();
      const pipeline: Pipeline = {
        id, name: name.trim(), description: description || '',
        steps: (steps || []).map((s: any, i: number) => ({
          id: s.id || uuidv4(), templateId: s.templateId, order: i + 1,
          overrides: s.overrides, condition: s.condition,
        })),
        createdAt: now, updatedAt: now,
      };

      const validation = repo.validate(pipeline);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: validation.errors.join('; ') });
      }

      const created = repo.create(pipeline);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.put('/:id', (req: Request, res: Response) => {
    try {
      const updated = repo.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ success: false, error: 'Pipeline not found' });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    try {
      if (!repo.delete(req.params.id)) return res.status(404).json({ success: false, error: 'Pipeline not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/:id/validate', (req: Request, res: Response) => {
    try {
      const pipeline = repo.getById(req.params.id);
      if (!pipeline) return res.status(404).json({ success: false, error: 'Pipeline not found' });
      const result = repo.validate(pipeline);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
