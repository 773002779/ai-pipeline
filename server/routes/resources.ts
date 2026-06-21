import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../db/helper';
import { ResourceRepository } from '../db/repositories/resources';
import { scanLocalSkills, scanLocalMcps, scanMarketplacePlugins, fetchGitHubPlugin, scanDirectory } from '../resources/scanner';
import type { Resource, ResourceType } from '../../shared/types';

export function createResourceRoutes(dbHelper: DbHelper): Router {
  const router = Router();
  const repo = new ResourceRepository(dbHelper);

  // List all resources
  router.get('/', (req: Request, res: Response) => {
    try {
      const { type, enabled } = req.query;
      const filters: { type?: ResourceType; enabled?: boolean } = {};
      if (type && ['skill', 'agent', 'mcp'].includes(type as string)) {
        filters.type = type as ResourceType;
      }
      if (enabled !== undefined) {
        filters.enabled = enabled === 'true';
      }
      const resources = repo.list(filters);
      res.json({ success: true, data: resources });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Get by id
  router.get('/:id', (req: Request, res: Response) => {
    try {
      const resource = repo.getById(req.params.id);
      if (!resource) {
        return res.status(404).json({ success: false, error: 'Resource not found' });
      }
      res.json({ success: true, data: resource });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Create
  router.post('/', (req: Request, res: Response) => {
    try {
      const { type, name, description, version, source, sourcePath, config, enabled } = req.body;

      // Validation
      if (!['skill', 'agent', 'mcp'].includes(type)) {
        return res.status(400).json({ success: false, error: 'Invalid type. Must be: skill, agent, or mcp' });
      }
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ success: false, error: 'Name is required' });
      }
      if (!['builtin', 'claude-code', 'manual', 'import', 'git'].includes(source || 'manual')) {
        return res.status(400).json({ success: false, error: 'Invalid source' });
      }

      // Validate config by type
      if (type === 'skill' && !(config as any)?.prompt) {
        return res.status(400).json({ success: false, error: 'Skill config requires a prompt' });
      }
      if (type === 'agent' && !(config as any)?.systemPrompt) {
        return res.status(400).json({ success: false, error: 'Agent config requires a systemPrompt' });
      }
      if (type === 'mcp' && !(config as any)?.command && !(config as any)?.url) {
        return res.status(400).json({ success: false, error: 'MCP config requires a command or url' });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      const resource: Resource = {
        id,
        type: type as ResourceType,
        name: name.trim(),
        description: description || '',
        version: version || '1.0.0',
        source: source || 'manual',
        sourcePath: sourcePath || undefined,
        config,
        enabled: enabled !== false,
        createdAt: now,
        updatedAt: now,
      };

      const created = repo.create(resource);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('UNIQUE constraint')) {
        return res.status(409).json({ success: false, error: 'Resource with this ID already exists' });
      }
      res.status(500).json({ success: false, error: msg });
    }
  });

  // Update
  router.put('/:id', (req: Request, res: Response) => {
    try {
      const updates = req.body;
      // Don't allow changing type or id
      delete updates.type;
      delete updates.id;

      const updated = repo.update(req.params.id, updates);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Resource not found' });
      }
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Delete
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const deleted = repo.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Resource not found' });
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // Toggle enabled/disabled
  router.post('/:id/toggle', (req: Request, res: Response) => {
    try {
      const toggled = repo.toggle(req.params.id);
      if (!toggled) {
        return res.status(404).json({ success: false, error: 'Resource not found' });
      }
      res.json({ success: true, data: toggled });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // ---- Discovery & Import Routes ----

  /** GET /scan/claude-code — scan local Claude Code for installed skills & MCPs */
  router.get('/scan/claude-code', (_req: Request, res: Response) => {
    try {
      const skills = scanLocalSkills();
      const mcps = scanLocalMcps();
      // Mark which ones are already imported
      const existing = repo.list();
      const existingNames = new Set(existing.map(r => r.name));
      res.json({
        success: true,
        data: {
          skills: skills.map(s => ({ ...s, alreadyImported: existingNames.has(s.name) })),
          mcps: mcps.map(m => ({ ...m, alreadyImported: existingNames.has(m.name) })),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** GET /marketplace — list plugins from local marketplace clone */
  router.get('/marketplace', (_req: Request, res: Response) => {
    try {
      const plugins = scanMarketplacePlugins();
      const existing = repo.list();
      const existingNames = new Set(existing.map(r => r.name));
      res.json({
        success: true,
        data: plugins.map(p => ({ ...p, alreadyImported: existingNames.has(p.name) })),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** POST /import — import a discovered resource into the database */
  router.post('/import', (req: Request, res: Response) => {
    try {
      const { name, type, description, version, source, sourcePath, config } = req.body;

      if (!['skill', 'agent', 'mcp'].includes(type)) {
        return res.status(400).json({ success: false, error: 'Invalid type' });
      }
      if (!name || !config) {
        return res.status(400).json({ success: false, error: 'name and config are required' });
      }

      // Check for duplicate name
      const existing = repo.list().find(r => r.name === name);
      if (existing) {
        return res.status(409).json({ success: false, error: `Resource "${name}" already exists` });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      const resource: Resource = {
        id,
        type: type as ResourceType,
        name: name.trim(),
        description: description || '',
        version: version || '1.0.0',
        source: source || 'import',
        sourcePath: sourcePath || undefined,
        config,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };

      const created = repo.create(resource);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('UNIQUE constraint')) {
        return res.status(409).json({ success: false, error: 'Resource already exists' });
      }
      res.status(500).json({ success: false, error: msg });
    }
  });

  /** POST /fetch-git — fetch plugin metadata from a GitHub URL */
  router.post('/fetch-git', async (req: Request, res: Response) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ success: false, error: 'url is required' });
      }
      const info = await fetchGitHubPlugin(url);
      if (!info) {
        return res.status(404).json({ success: false, error: 'No plugin found at this URL' });
      }
      const existing = repo.list();
      const alreadyImported = existing.some(r => r.name === info.name);
      res.json({ success: true, data: { ...info, alreadyImported } });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** POST /scan-directory — scan a local directory for resource definition files */
  router.post('/scan-directory', (req: Request, res: Response) => {
    try {
      const { dirPath } = req.body;
      if (!dirPath || typeof dirPath !== 'string') {
        return res.status(400).json({ success: false, error: 'dirPath is required' });
      }
      const discovered = scanDirectory(dirPath.trim());
      const existing = repo.list();
      const existingNames = new Set(existing.map(r => r.name));
      res.json({
        success: true,
        data: discovered.map(d => ({ ...d, alreadyImported: existingNames.has(d.name) })),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
