import express from 'express';
import cors from 'cors';
import { config } from './config';
import { DbHelper } from './db/helper';
import { ResourceRepository } from './db/repositories/resources';
import { StepRepository } from './db/repositories/steps';
import { SessionChannel } from './ws/session-channel';
import { createResourceRoutes } from './routes/resources';
import { createStepRoutes } from './routes/steps';
import { createPipelineRoutes } from './routes/pipelines';
import { createSessionRoutes } from './routes/sessions';

export interface AppOptions {
  dbHelper?: DbHelper;
  wsChannel?: SessionChannel;
}

export function createApp(options: AppOptions = {}) {
  const app = express();

  // Middleware
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
  });

  // API routes (if dbHelper provided)
  if (options.dbHelper) {
    const resourceRepo = new ResourceRepository(options.dbHelper);
    const stepRepo = new StepRepository(options.dbHelper);

    app.use('/api/resources', createResourceRoutes(options.dbHelper));
    app.use('/api/steps', createStepRoutes(options.dbHelper));
    app.use('/api/pipelines', createPipelineRoutes(options.dbHelper));
    app.use('/api/sessions', createSessionRoutes(options.dbHelper, {
      wsChannel: options.wsChannel,
      resourceRepo,
      stepRepo,
    }));
  }

  // 404 handler
  app.use('/api/*', (_req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  // Error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  });

  return app;
}
