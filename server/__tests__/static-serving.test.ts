import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createApp } from '../app';
import type { Database as SqlJsDatabase } from 'sql.js';

let server: http.Server;
let baseUrl: string;
let staticDir: string;

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);

  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>AI Pipeline SPA</body></html>', 'utf-8');

  const app = createApp({
    dbHelper: new DbHelper(db),
    staticDir,
  });
  await new Promise<void>(r => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => {
  server.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});

describe('static SPA serving (production mode)', () => {
  it('serves index.html at root', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AI Pipeline SPA');
  });

  it('falls back to index.html for SPA routes', async () => {
    const res = await fetch(`${baseUrl}/sessions/abc-123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AI Pipeline SPA');
  });

  it('does not swallow /api 404s', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
