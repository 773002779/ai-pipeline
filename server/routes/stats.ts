import { Router, Request, Response } from 'express';
import { StatsRepository } from '../db/repositories/stats';
import type { DbHelper } from '../db/helper';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createStatsRoutes(dbHelper: DbHelper): Router {
  const router = Router();
  const repo = new StatsRepository(dbHelper);

  router.get('/overview', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: repo.overview() });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get('/usage', (req: Request, res: Response) => {
    try {
      const to = (req.query.to as string) || toLocalDate(new Date());
      const from = (req.query.from as string) || toLocalDate(new Date(Date.now() - 6 * 86400_000));
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return res.status(400).json({ success: false, error: 'from/to 必须是 YYYY-MM-DD' });
      }
      res.json({
        success: true,
        data: {
          models: repo.modelUsage(from, to),
          daily: repo.dailyUsage(from, to),
          topSessions: repo.topSessions(from, to, 5),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
