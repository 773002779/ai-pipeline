import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { DbHelper } from './db/helper';
import { ResourceRepository } from './db/repositories/resources';
import { StepRepository } from './db/repositories/steps';
import { SessionChannel } from './ws/session-channel';
import { createResourceRoutes } from './routes/resources';
import { createStepRoutes } from './routes/steps';
import { createPipelineRoutes } from './routes/pipelines';
import { createSessionRoutes } from './routes/sessions';
import { createChatRoutes } from './routes/chat';
import { createProviderRoutes } from './routes/providers';
import { createStatsRoutes } from './routes/stats';
import { ProviderRepository } from './db/repositories/providers';
import type { Router } from 'express';
import type { StartupChecks } from './startup-checks';

export interface AppOptions {
  dbHelper?: DbHelper;
  wsChannel?: SessionChannel;
  llmProxy?: Router;          // /_llm 协议转换代理（index.ts 组装后传入）
  checks?: StartupChecks;     // 启动自检结果（Task 8 填充，本任务先留可选）
  staticDir?: string;         // 生产模式静态目录（Task 8 使用）
}

export function createApp(options: AppOptions = {}) {
  const app = express();

  // Middleware
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString(), checks: options.checks ?? null } });
  });

  // API routes (if dbHelper provided)
  if (options.dbHelper) {
    const resourceRepo = new ResourceRepository(options.dbHelper);
    const stepRepo = new StepRepository(options.dbHelper);
    const providerRepo = new ProviderRepository(options.dbHelper);

    app.use('/api/resources', createResourceRoutes(options.dbHelper));
    app.use('/api/steps', createStepRoutes(options.dbHelper));
    app.use('/api/pipelines', createPipelineRoutes(options.dbHelper));
    app.use('/api/providers', createProviderRoutes(providerRepo));
    app.use('/api/stats', createStatsRoutes(options.dbHelper));
    if (options.llmProxy) app.use('/_llm', options.llmProxy);
    app.use('/api/sessions', createSessionRoutes(options.dbHelper, {
      wsChannel: options.wsChannel,
      resourceRepo,
      stepRepo,
      providerRepo,
    }));
    app.use('/api/chat', createChatRoutes({ dbHelper: options.dbHelper, providerRepo }));
  }

  // 生产模式：托管前端构建产物 + SPA fallback
  if (options.staticDir && fs.existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/_llm') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
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
