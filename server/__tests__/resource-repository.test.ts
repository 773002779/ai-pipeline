import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ResourceRepository } from '../db/repositories/resources';
import type { Resource, SkillConfig, AgentConfig, McpConfig } from '../../shared/types';
import type { Database as SqlJsDatabase } from 'sql.js';

describe('ResourceRepository', () => {
  let db: SqlJsDatabase;
  let helper: DbHelper;
  let repo: ResourceRepository;

  beforeAll(async () => {
    db = await createMemoryDb();
    createTables(db);
    helper = new DbHelper(db);
    repo = new ResourceRepository(helper);
  });

  afterAll(() => db.close());

  beforeEach(() => {
    // Clean data between tests
    db.run("DELETE FROM resources");
  });

  const skillConfig: SkillConfig = {
    prompt: 'You are a code review expert. Review code for correctness, security, and performance.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
    tools: ['Read', 'Grep'],
  };

  const makeResource = (overrides: Partial<Resource> = {}): Resource => ({
    id: 'res-1',
    type: 'skill',
    name: 'Code Review Expert',
    description: 'Deep code review skill',
    version: '1.0.0',
    source: 'manual',
    config: skillConfig,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  describe('create', () => {
    it('should create a resource and return it', () => {
      const resource = makeResource();
      const created = repo.create(resource);

      expect(created.id).toBe('res-1');
      expect(created.type).toBe('skill');
      expect(created.name).toBe('Code Review Expert');
      expect(created.enabled).toBe(true);
    });

    it('should throw on duplicate id', () => {
      repo.create(makeResource());
      expect(() => repo.create(makeResource())).toThrow();
    });

    it('should store config as JSON', () => {
      repo.create(makeResource());
      const row = helper.get<{ config_json: string }>("SELECT config_json FROM resources WHERE id = ?", ['res-1']);
      const config = JSON.parse(row!.config_json) as SkillConfig;
      expect(config.prompt).toContain('code review expert');
      expect(config.tools).toEqual(['Read', 'Grep']);
    });
  });

  describe('getById', () => {
    it('should return resource by id', () => {
      repo.create(makeResource());
      const found = repo.getById('res-1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Code Review Expert');
    });

    it('should return null for non-existent id', () => {
      expect(repo.getById('nope')).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all resources', () => {
      repo.create(makeResource({ id: 'r1', type: 'skill', name: 'Skill A' }));
      repo.create(makeResource({ id: 'r2', type: 'agent', name: 'Agent B' }));
      repo.create(makeResource({ id: 'r3', type: 'mcp', name: 'MCP C' }));

      const all = repo.list();
      expect(all).toHaveLength(3);
    });

    it('should filter by type', () => {
      repo.create(makeResource({ id: 'r1', type: 'skill' }));
      repo.create(makeResource({ id: 'r2', type: 'agent' }));

      const skills = repo.list({ type: 'skill' });
      expect(skills).toHaveLength(1);
      expect(skills[0].type).toBe('skill');
    });

    it('should filter by enabled status', () => {
      repo.create(makeResource({ id: 'r1', enabled: true }));
      repo.create(makeResource({ id: 'r2', enabled: false }));

      const enabled = repo.list({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe('r1');
    });
  });

  describe('update', () => {
    it('should update resource fields', () => {
      repo.create(makeResource());
      const updated = repo.update('res-1', { name: 'New Name', version: '2.0.0' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New Name');
      expect(updated!.version).toBe('2.0.0');
      // unchanged fields preserved
      expect(updated!.type).toBe('skill');
    });

    it('should return null for non-existent resource', () => {
      expect(repo.update('nope', { name: 'X' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete a resource', () => {
      repo.create(makeResource());
      const deleted = repo.delete('res-1');
      expect(deleted).toBe(true);
      expect(repo.getById('res-1')).toBeNull();
    });

    it('should return false for non-existent resource', () => {
      expect(repo.delete('nope')).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should toggle enabled status', () => {
      repo.create(makeResource({ enabled: true }));
      const toggled = repo.toggle('res-1');
      expect(toggled?.enabled).toBe(false);

      const toggledAgain = repo.toggle('res-1');
      expect(toggledAgain?.enabled).toBe(true);
    });
  });

  describe('agent and mcp configs', () => {
    it('should handle AgentConfig', () => {
      const agentConfig: AgentConfig = {
        systemPrompt: 'You are a Java backend developer.',
        model: 'claude-opus-4-8',
        tools: ['Read', 'Write', 'Edit', 'Bash'],
        mcpServerIds: ['mcp-1'],
      };
      repo.create(makeResource({
        id: 'agent-1',
        type: 'agent',
        name: 'Java Dev',
        config: agentConfig,
      }));

      const found = repo.getById('agent-1');
      const config = found!.config as AgentConfig;
      expect(config.model).toBe('claude-opus-4-8');
      expect(config.mcpServerIds).toEqual(['mcp-1']);
    });

    it('should handle McpConfig', () => {
      const mcpConfig: McpConfig = {
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server-github'],
        env: { GITHUB_TOKEN: 'xxx' },
      };
      repo.create(makeResource({
        id: 'mcp-1',
        type: 'mcp',
        name: 'GitHub MCP',
        config: mcpConfig,
      }));

      const found = repo.getById('mcp-1');
      const config = found!.config as McpConfig;
      expect(config.command).toBe('npx');
      expect(config.env?.GITHUB_TOKEN).toBe('xxx');
    });
  });
});
