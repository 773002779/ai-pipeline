import { Database as SqlJsDatabase, SqlValue } from 'sql.js';

/**
 * Thin wrapper around sql.js to provide a simpler API
 * similar to better-sqlite3 for common operations.
 */
export class DbHelper {
  constructor(private db: SqlJsDatabase) {}

  /** Run a statement with parameters — returns the raw db */
  run(sql: string, params: SqlValue[] = []): SqlJsDatabase {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.free();
    return this.db;
  }

  /** Get a single row as object */
  get<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as T;
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  }

  /** Get all rows as objects */
  all<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
    const results: T[] = [];
    const stmt = this.db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as T);
    }
    stmt.free();
    return results;
  }

  /** Execute raw SQL (for DDL, multiple statements) */
  exec(sql: string): void {
    this.db.run(sql);
  }

  /** Get raw database for advanced use */
  raw(): SqlJsDatabase {
    return this.db;
  }
}
