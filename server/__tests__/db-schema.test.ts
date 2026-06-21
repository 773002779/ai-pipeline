import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import type { Database as SqlJsDatabase } from 'sql.js';

describe('Database Schema', () => {
  let db: SqlJsDatabase;
  let helper: DbHelper;

  beforeAll(async () => {
    db = await createMemoryDb();
    createTables(db);
    helper = new DbHelper(db);
  });

  afterAll(() => {
    db.close();
  });

  describe('resources table', () => {
    it('should create resources table with all columns', () => {
      const result = db.exec("PRAGMA table_info('resources')");
      expect(result).toHaveLength(1);
      const names = result[0].values.map((row: unknown[]) => row[1]);
      expect(names).toContain('id');
      expect(names).toContain('type');
      expect(names).toContain('name');
      expect(names).toContain('description');
      expect(names).toContain('version');
      expect(names).toContain('source');
      expect(names).toContain('source_path');
      expect(names).toContain('config_json');
      expect(names).toContain('enabled');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');
    });

    it('should enforce type check constraint', () => {
      expect(() => {
        helper.run(`INSERT INTO resources (id, type, name, version, source, config_json)
          VALUES ('test-1', 'invalid', 'Test', '1.0.0', 'manual', '{}')`);
      }).toThrow();
    });

    it('should allow valid types: skill, agent, mcp', () => {
      for (const type of ['skill', 'agent', 'mcp']) {
        helper.run(
          `INSERT INTO resources (id, type, name, version, source, config_json) VALUES (?, ?, ?, '1.0.0', 'manual', '{}')`,
          [`test-${type}`, type, type]
        );
      }
      const row = helper.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM resources WHERE id LIKE 'test-%'");
      expect(row?.cnt).toBe(3);
    });

    it('should enforce source check constraint', () => {
      expect(() => {
        helper.run(`INSERT INTO resources (id, type, name, version, source, config_json)
          VALUES ('bad-source', 'skill', 'Test', '1.0.0', 'bad', '{}')`);
      }).toThrow();
    });
  });

  describe('step_templates table', () => {
    it('should create step_templates table', () => {
      const result = db.exec("PRAGMA table_info('step_templates')");
      const names = result[0].values.map((row: unknown[]) => row[1]);
      expect(names).toContain('id');
      expect(names).toContain('name');
      expect(names).toContain('category');
      expect(names).toContain('config_json');
      expect(names).toContain('source_path');
    });
  });

  describe('pipelines table', () => {
    it('should create pipelines table', () => {
      const result = db.exec("PRAGMA table_info('pipelines')");
      const names = result[0].values.map((row: unknown[]) => row[1]);
      expect(names).toContain('id');
      expect(names).toContain('name');
      expect(names).toContain('description');
      expect(names).toContain('definition_json');
    });
  });

  // Helper: insert parent rows needed for FK constraints
  let setupCounter = 0;
  function setupSession(): { pipelineId: string; sessionId: string } {
    setupCounter++;
    const pId = `p_setup_${setupCounter}`;
    const sId = `s_setup_${setupCounter}`;
    helper.run(`INSERT INTO pipelines (id, name, definition_json) VALUES (?, 'test', '{}')`, [pId]);
    helper.run(`INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, workspaces_json)
      VALUES (?, ?, '{}', 'Test', 'test', '[]')`, [sId, pId]);
    return { pipelineId: pId, sessionId: sId };
  }

  describe('sessions table', () => {
    it('should create sessions table with status default idle', () => {
      const { sessionId } = setupSession();
      const row = helper.get<{ status: string }>("SELECT status FROM sessions WHERE id = ?", [sessionId]);
      expect(row?.status).toBe('idle');
    });
  });

  describe('session_steps table', () => {
    it('should create session_steps with default values', () => {
      const { sessionId } = setupSession();
      helper.run(`INSERT INTO session_steps (session_id, template_id, step_name, step_order)
        VALUES (?, 't1', 'test step', 1)`, [sessionId]);
      const row = helper.get<{ status: string; retry_count: number }>(
        `SELECT status, retry_count FROM session_steps WHERE session_id = ?`, [sessionId]
      );
      expect(row?.status).toBe('pending');
      expect(row?.retry_count).toBe(0);
    });
  });

  describe('messages table', () => {
    it('should allow NULL step_id for free-form chat', () => {
      const { sessionId } = setupSession();
      helper.run(`INSERT INTO messages (id, session_id, role, content)
        VALUES (?, ?, 'user', 'hello')`, [`m_msg1_${sessionId}`, sessionId]);
      const row = helper.get<{ step_id: string | null }>(
        `SELECT step_id FROM messages WHERE id = ?`, [`m_msg1_${sessionId}`]
      );
      expect(row?.step_id).toBeNull();
    });

    it('should store tool_calls_json', () => {
      const { sessionId } = setupSession();
      helper.run(`INSERT INTO messages (id, session_id, step_id, role, content, tool_calls_json)
        VALUES (?, ?, 't1', 'assistant', 'done', ?)`,
        [`m_msg2_${sessionId}`, sessionId, '{"tool":"edit"}']);
      const row = helper.get<{ tool_calls_json: string }>(
        `SELECT tool_calls_json FROM messages WHERE id = ?`, [`m_msg2_${sessionId}`]
      );
      expect(JSON.parse(row!.tool_calls_json)).toEqual({ tool: 'edit' });
    });
  });

  describe('action_items table', () => {
    it('should create action_items with severity check', () => {
      const { sessionId } = setupSession();
      helper.run(`INSERT INTO action_items (id, session_id, step_id, severity, title, description)
        VALUES (?, ?, 't1', 'warning', 'Issue', 'desc')`, [`ai_${sessionId}`, sessionId]);
      const row = helper.get<{ severity: string; status: string }>(
        `SELECT severity, status FROM action_items WHERE id = ?`, [`ai_${sessionId}`]
      );
      expect(row?.severity).toBe('warning');
      expect(row?.status).toBe('pending');
    });
  });

  describe('permission_whitelist table', () => {
    it('should enforce unique session_id + tool_name', () => {
      const { sessionId } = setupSession();
      helper.run(`INSERT INTO permission_whitelist (session_id, tool_name) VALUES (?, 'Bash')`, [sessionId]);
      expect(() => {
        helper.run(`INSERT INTO permission_whitelist (session_id, tool_name) VALUES (?, 'Bash')`, [sessionId]);
      }).toThrow();
    });
  });
});
