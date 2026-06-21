import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';

let server: http.Server;
let baseUrl: string;

describe('Express API Health', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    app.get('/api/health', (_req, res) => {
      res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('GET /api/health should return ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('should return JSON content type', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('should handle 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
  });
});
