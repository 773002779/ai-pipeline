import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import fs from 'fs';
import path from 'path';

let sqlJs: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;

const DEFAULT_DB_PATH = path.join(process.cwd(), '.pipeline', 'data.db');

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJs) {
    sqlJs = await initSqlJs();
  }
  return sqlJs;
}

export async function getDb(dbPath?: string): Promise<SqlJsDatabase> {
  if (!db) {
    const SQL = await getSqlJs();
    const resolvedPath = dbPath || DEFAULT_DB_PATH;

    if (fs.existsSync(resolvedPath)) {
      const buffer = fs.readFileSync(resolvedPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON');
  }
  return db;
}

export function saveDb(dbPath?: string): void {
  if (!db) return;
  const resolvedPath = dbPath || DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(resolvedPath, buffer);
}

export async function closeDb(dbPath?: string): Promise<void> {
  if (db) {
    saveDb(dbPath);
    db.close();
    db = null;
  }
}

/** Create an in-memory database (for testing) */
export async function createMemoryDb(): Promise<SqlJsDatabase> {
  const SQL = await getSqlJs();
  const memDb = new SQL.Database();
  memDb.run('PRAGMA foreign_keys = ON');
  return memDb;
}
