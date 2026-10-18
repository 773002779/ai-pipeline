import { describe, it, expect, beforeAll } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { UsageRepository } from '../db/repositories/usage';

let dbHelper: DbHelper;
let repo: UsageRepository;

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  repo = new UsageRepository(dbHelper);
  // Parent rows for FK constraints (usage_records.session_id → sessions.id)
  dbHelper.run(`INSERT INTO pipelines (id, name, definition_json) VALUES ('p-usage', 'test', '{}')`);
  dbHelper.run(`INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, workspaces_json)
    VALUES ('sess-1', 'p-usage', '{}', 'Test', 'test', '[]')`);
  dbHelper.run(`INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, workspaces_json)
    VALUES ('sess-2', 'p-usage', '{}', 'Test', 'test', '[]')`);
});

describe('UsageRepository', () => {
  it('add 写入一行完整记录', () => {
    repo.add({
      sessionId: 'sess-1', stepId: 'step-1', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5,
    });
    const row = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'sess-1'",
    );
    expect(row).toBeDefined();
    expect(row!['model']).toBe('deepseek-chat');
    expect(row!['input_tokens']).toBe(100);
    expect(row!['output_tokens']).toBe(50);
    expect(row!['cache_read_tokens']).toBe(10);
    expect(row!['cache_creation_tokens']).toBe(5);
    expect(row!['step_id']).toBe('step-1');
    expect(row!['created_at']).toBeTruthy();
  });

  it('stepId 可省略（chat 场景）', () => {
    repo.add({
      sessionId: 'sess-2', model: 'gpt-4o',
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    const row = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'sess-2'",
    );
    expect(row!['step_id']).toBeNull();
  });
});
