import { Database as SqlJsDatabase } from 'sql.js';

export function createTables(db: SqlJsDatabase): void {
  // sql.js doesn't support IF NOT EXISTS for tables,
  // so we run CREATE TABLE and ignore "already exists" errors
  const statements = [
    `CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('skill', 'agent', 'mcp')),
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      version TEXT NOT NULL DEFAULT '1.0.0',
      source TEXT NOT NULL CHECK (source IN ('builtin', 'claude-code', 'manual', 'import', 'git')),
      source_path TEXT,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE step_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '工具',
      description TEXT DEFAULT '',
      config_json TEXT NOT NULL,
      source_path TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE pipelines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      pipeline_id TEXT NOT NULL,
      pipeline_snapshot TEXT NOT NULL,
      name TEXT NOT NULL,
      requirement TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      environment_json TEXT,
      current_step_index INTEGER DEFAULT 0,
      step_overrides_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
    )`,
    `CREATE TABLE session_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      output_path TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    `CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    `CREATE TABLE action_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'suggestion', 'question')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      file_path TEXT,
      line_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'deferred')),
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
    `CREATE TABLE permission_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      UNIQUE(session_id, tool_name)
    )`,
    `CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL,
      max_tokens INTEGER,
      is_active INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'continue')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE usage_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
  ];

  for (const sql of statements) {
    try {
      db.run(sql);
    } catch (_e) {
      // Table already exists — ignore
    }
  }

  // Create indices (also ignore if exists)
  const indices = [
    `CREATE INDEX idx_resources_type ON resources(type)`,
    `CREATE INDEX idx_resources_enabled ON resources(enabled)`,
    `CREATE INDEX idx_sessions_status ON sessions(status)`,
    `CREATE INDEX idx_session_steps_session ON session_steps(session_id)`,
    `CREATE INDEX idx_messages_session ON messages(session_id)`,
    `CREATE INDEX idx_action_items_session ON action_items(session_id)`,
    `CREATE INDEX idx_action_items_status ON action_items(session_id, status)`,
    `CREATE UNIQUE INDEX idx_providers_one_active ON providers(is_active) WHERE is_active = 1`,
    `CREATE INDEX idx_usage_created ON usage_records(created_at)`,
    `CREATE INDEX idx_usage_session ON usage_records(session_id)`,
  ];

  for (const sql of indices) {
    try {
      db.run(sql);
    } catch (_e) {
      // Index already exists — ignore
    }
  }

  // Migrations — add columns that may not exist on older databases
  try {
    db.run("ALTER TABLE messages ADD COLUMN thinking_json TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_sdk_session_id TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_model TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_summary TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
}
