import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createResourceRoutes } from '../routes/resources';
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase;
let server: http.Server;
let baseUrl: string;

function createTestApp() {
  const app = express();
  app.use(express.json());
  const helper = new DbHelper(db);
  const router = createResourceRoutes(helper);
  app.use('/api/resources', router);
  app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'Not found' }));
  return app;
}

describe('Resource API', () => {
  beforeAll(async () => {
    db = await createMemoryDb();
    createTables(db);

    const app = createTestApp();
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
    db.close();
    if (server) server.close();
  });

  const skillPayload = {
    type: 'skill',
    name: 'Code Review Expert',
    description: 'Deep code review',
    version: '1.0.0',
    source: 'manual',
    config: {
      prompt: 'You are a code review expert.',
      tools: ['Read', 'Grep'],
    },
  };

  describe('POST /api/resources', () => {
    it('should create a resource and return it', async () => {
      const res = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(skillPayload),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Code Review Expert');
      expect(body.data.type).toBe('skill');
      expect(body.data.id).toBeDefined();
    });

    it('should reject invalid type', async () => {
      const res = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...skillPayload, type: 'invalid' }),
      });
      expect(res.status).toBe(400);
    });

    it('should reject missing name', async () => {
      const res = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...skillPayload, name: '' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/resources', () => {
    it('should list all resources', async () => {
      const res = await fetch(`${baseUrl}/api/resources`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // At least the resources created in prior tests
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should return data array with valid resource shape', async () => {
      const res = await fetch(`${baseUrl}/api/resources`);
      const body = await res.json();
      if (body.data.length > 0) {
        const r = body.data[0];
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('type');
        expect(r).toHaveProperty('name');
        expect(r).toHaveProperty('config');
      }
    });

    it('should filter by type', async () => {
      // Create a fresh agent to ensure there's at least one
      await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...skillPayload, name: 'FilterAgent', type: 'agent', config: { systemPrompt: 'Test', tools: [] } }),
      });

      const res = await fetch(`${baseUrl}/api/resources?type=agent`);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const r of body.data) {
        expect(r.type).toBe('agent');
      }
    });
  });

  describe('GET /api/resources/:id', () => {
    it('should return resource by id', async () => {
      const created = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...skillPayload, name: 'Get Me' }),
      });
      const { data } = await created.json();

      const res = await fetch(`${baseUrl}/api/resources/${data.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Get Me');
    });

    it('should return 404 for non-existent id', async () => {
      const res = await fetch(`${baseUrl}/api/resources/non-existent`);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/resources/:id', () => {
    it('should update a resource', async () => {
      const created = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(skillPayload),
      });
      const { data } = await created.json();

      const res = await fetch(`${baseUrl}/api/resources/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Updated Name');
    });
  });

  describe('DELETE /api/resources/:id', () => {
    it('should delete a resource', async () => {
      const created = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(skillPayload),
      });
      const { data } = await created.json();

      const res = await fetch(`${baseUrl}/api/resources/${data.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      // Verify deleted
      const getRes = await fetch(`${baseUrl}/api/resources/${data.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  describe('POST /api/resources/:id/toggle', () => {
    it('should toggle enabled status', async () => {
      const created = await fetch(`${baseUrl}/api/resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(skillPayload),
      });
      const { data } = await created.json();
      expect(data.enabled).toBe(true);

      const res = await fetch(`${baseUrl}/api/resources/${data.id}/toggle`, { method: 'POST' });
      const body = await res.json();
      expect(body.data.enabled).toBe(false);
    });
  });
});
