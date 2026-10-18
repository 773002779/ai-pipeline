import { Router, Request, Response } from 'express';
import fs from 'fs';
import { listTree } from '../fs/tree';

export function createFsRoutes(): Router {
  const router = Router();

  router.get('/tree', (req: Request, res: Response) => {
    try {
      const root = req.query.root as string;
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return res.status(400).json({ success: false, error: 'root 必须是已存在的目录' });
      }
      res.json({ success: true, data: listTree(root) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
