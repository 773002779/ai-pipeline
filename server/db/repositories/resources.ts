import { DbHelper } from '../helper';
import type { SqlValue } from 'sql.js';
import type { Resource, ResourceType } from '../../../shared/types';

interface ListFilters {
  type?: ResourceType;
  enabled?: boolean;
}

export class ResourceRepository {
  constructor(private db: DbHelper) {}

  create(resource: Resource): Resource {
    this.db.run(
      `INSERT INTO resources (id, type, name, description, version, source, source_path, config_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resource.id,
        resource.type,
        resource.name,
        resource.description || '',
        resource.version,
        resource.source,
        resource.sourcePath || null,
        JSON.stringify(resource.config),
        resource.enabled ? 1 : 0,
        resource.createdAt || new Date().toISOString(),
        resource.updatedAt || new Date().toISOString(),
      ]
    );
    return resource;
  }

  getById(id: string): Resource | null {
    return this.rowToResource(
      this.db.get<Record<string, unknown>>('SELECT * FROM resources WHERE id = ?', [id])
    );
  }

  list(filters?: ListFilters): Resource[] {
    let sql = 'SELECT * FROM resources WHERE 1=1';
    const params: SqlValue[] = [];

    if (filters?.type) {
      sql += ' AND type = ?';
      params.push(filters.type);
    }
    if (filters?.enabled !== undefined) {
      sql += ' AND enabled = ?';
      params.push(filters.enabled ? 1 : 0);
    }

    sql += ' ORDER BY type, name';
    const rows = this.db.all<Record<string, unknown>>(sql, params);
    return rows.map((r) => this.rowToResource(r)).filter((r): r is Resource => r !== null);
  }

  update(id: string, updates: Partial<Resource>): Resource | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };

    this.db.run(
      `UPDATE resources SET name=?, description=?, version=?, config_json=?, enabled=?, source_path=?, updated_at=?
       WHERE id=?`,
      [
        updated.name,
        updated.description || '',
        updated.version,
        JSON.stringify(updated.config),
        updated.enabled ? 1 : 0,
        updated.sourcePath || null,
        updated.updatedAt,
        id,
      ]
    );

    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    this.db.run('DELETE FROM resources WHERE id = ?', [id]);
    return true;
  }

  toggle(id: string): Resource | null {
    const existing = this.getById(id);
    if (!existing) return null;
    return this.update(id, { enabled: !existing.enabled });
  }

  private rowToResource(row: Record<string, unknown> | undefined): Resource | null {
    if (!row) return null;
    return {
      id: row['id'] as string,
      type: row['type'] as Resource['type'],
      name: row['name'] as string,
      description: (row['description'] as string) || '',
      version: (row['version'] as string) || '1.0.0',
      source: row['source'] as Resource['source'],
      sourcePath: (row['source_path'] as string) || undefined,
      config: JSON.parse(row['config_json'] as string),
      enabled: row['enabled'] === 1,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }
}
