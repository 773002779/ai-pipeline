import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createApp } from './app';
import { config } from './config';
import { getDb, saveDb, closeDb } from './db/connection';
import { createTables } from './db/schema';
import { DbHelper } from './db/helper';
import { ResourceLoader } from './resources/loader';
import { ResourceRepository } from './db/repositories/resources';
import { StepLoader } from './steps/loader';
import { StepRepository } from './db/repositories/steps';
import { ProviderRepository } from './db/repositories/providers';
import { ensureBuiltinChatPipeline } from './chat/builtin-pipeline';
import { SessionChannel } from './ws/session-channel';
import { createLlmProxy } from './llm/proxy';
import { setInternalToken } from './llm/internal-token';
import { runStartupChecks, type StartupChecks } from './startup-checks';

async function main() {
  // Initialize database
  const db = await getDb();
  createTables(db);
  const dbHelper = new DbHelper(db);
  console.log('Database initialized');

  // Recover zombie sessions: any 'running' session from a previous process
  // is stuck because the in-memory executor died with the old process
  const zombieSessions = dbHelper.all<{ id: string; name: string }>(
    "SELECT id, name FROM sessions WHERE status = 'running'"
  );
  if (zombieSessions.length > 0) {
    console.log(`[startup] Found ${zombieSessions.length} zombie session(s) — resetting to error`);
    for (const s of zombieSessions) {
      dbHelper.run("UPDATE sessions SET status = 'error' WHERE id = ?", [s.id]);
      console.log(`[startup]   Reset: ${s.name} (${s.id.substring(0, 8)}...)`);
    }
  }

  // Load YAML resources and steps
  const resourceRepo = new ResourceRepository(dbHelper);
  const resourceLoader = new ResourceLoader(resourceRepo);
  const resourceCount = resourceLoader.loadFromDirectory();
  console.log(`Loaded ${resourceCount} resources from .pipeline/resources/`);

  const stepRepo = new StepRepository(dbHelper);
  const stepLoader = new StepLoader(stepRepo);
  const stepCount = stepLoader.loadFromDirectory();
  console.log(`Loaded ${stepCount} step templates from .pipeline/steps/`);

  ensureBuiltinChatPipeline(dbHelper);
  console.log('Builtin chat pipeline ensured');

  // LLM 代理：内部令牌 + 自检 + 隔离的 Claude 配置目录
  const internalToken = randomUUID();
  setInternalToken(internalToken);
  const providerRepo = new ProviderRepository(dbHelper);
  const checks: StartupChecks = runStartupChecks({ hasActiveProvider: !!providerRepo.getActive() });
  if (checks.gitBashPath) {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = checks.gitBashPath;
  }
  fs.mkdirSync(path.join(process.cwd(), '.pipeline', 'claude-config'), { recursive: true });

  // Create HTTP server (WebSocket attached first so routes can reference it)
  const server = http.createServer();
  const wsChannel = new SessionChannel(server);
  console.log('WebSocket server initialized at /ws/session');

  const app = createApp({
    dbHelper,
    wsChannel,
    llmProxy: createLlmProxy(providerRepo, internalToken),
    staticDir: process.env.NODE_ENV === 'production' ? path.join(process.cwd(), 'dist') : undefined,
    checks,
  });
  server.on('request', app);

  server.listen(config.port, () => {
    console.log(`\n  ╔══════════════════════════════════════════════╗`);
    console.log(`  ║   AI Pipeline - 本地 Claude 流水线开发平台  ║`);
    console.log(`  ╠══════════════════════════════════════════════╣`);
    console.log(`  ║  Server:  http://localhost:${config.port}              ║`);
    console.log(`  ║  Web UI:  http://localhost:5173              ║`);
    console.log(`  ║  Health:  /api/health                       ║`);
    console.log(`  ║  API:     /api/resources | steps | pipelines ║`);
    console.log(`  ║           /api/sessions                      ║`);
    console.log(`  ║           /api/chat | /api/stats | /api/fs   ║`);
    console.log(`  ║  LLM代理: /_llm (内置令牌)  CLI: ${checks.cliBundled ? '已内置' : '缺失!'}          ║`);
    console.log(`  ║  GitBash: ${checks.gitBashStatus === 'ok' ? '已定位' : checks.gitBashStatus}   生效模型: ${checks.hasActiveProvider ? '已配置' : '未配置!'}  ║`);
    console.log(`  ║  Claude配置目录: .pipeline/claude-config (已隔离)        ║`);
    console.log(`  ║  WS:      /ws/session?sessionId=xxx          ║`);
    console.log(`  ╚══════════════════════════════════════════════╝\n`);
  });

  // Auto-save database every 5 seconds
  const saveInterval = setInterval(() => {
    try {
      saveDb(config.dbPath);
    } catch (err) {
      console.warn('DB auto-save warning:', (err as Error).message);
    }
  }, 5000);

  // Graceful shutdown: save database before exit
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — saving database and shutting down...`);
    clearInterval(saveInterval);
    try {
      await closeDb(config.dbPath);
      console.log('Database saved. Goodbye.');
      process.exit(0);
    } catch (err) {
      console.error('Failed to save database:', (err as Error).message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Windows-specific: Ctrl+C in terminal sends SIGINT, but ensure cleanup
  process.on('beforeExit', () => {
    clearInterval(saveInterval);
    saveDb(config.dbPath);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
