import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';
import type { LlmProvider } from '../../../shared/types';

export class ProviderRepository {
  constructor(private db: DbHelper) {}

  create(p: Omit<LlmProvider, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): LlmProvider {
    const id = p.id || uuidv4();
    const now = new Date().toISOString();
    const provider: LlmProvider = { ...p, id, createdAt: now, updatedAt: now };
    this.db.run(
      `INSERT INTO providers (id, name, protocol, base_url, api_key, model, temperature, max_tokens, is_active, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, provider.name, provider.protocol, provider.baseUrl, provider.apiKey, provider.model,
        provider.temperature ?? null, provider.maxTokens ?? null, provider.isActive ? 1 : 0,
        provider.source, now, now]
    );
    return provider;
  }

  getById(id: string): LlmProvider | null {
    return this.rowToProvider(
      this.db.get<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?', [id])
    );
  }

  list(): LlmProvider[] {
    return this.db.all<Record<string, unknown>>(
      'SELECT * FROM providers ORDER BY is_active DESC, updated_at DESC'
    ).map(r => this.rowToProvider(r)).filter((p): p is LlmProvider => p !== null);
  }

  update(id: string, updates: Partial<Omit<LlmProvider, 'id' | 'createdAt'>>): LlmProvider | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged: LlmProvider = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    this.db.run(
      `UPDATE providers SET name=?, protocol=?, base_url=?, api_key=?, model=?, temperature=?, max_tokens=?, is_active=?, source=?, updated_at=? WHERE id=?`,
      [merged.name, merged.protocol, merged.baseUrl, merged.apiKey, merged.model,
        merged.temperature ?? null, merged.maxTokens ?? null, merged.isActive ? 1 : 0,
        merged.source, merged.updatedAt, id]
    );
    return merged;
  }

  delete(id: string): boolean {
    if (!this.getById(id)) return false;
    this.db.run('DELETE FROM providers WHERE id = ?', [id]);
    return true;
  }

  /** Exclusive activation: target on, everyone else off */
  activate(id: string): LlmProvider | null {
    if (!this.getById(id)) return null;
    this.db.run('UPDATE providers SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
    return this.getById(id);
  }

  getActive(): LlmProvider | null {
    return this.rowToProvider(
      this.db.get<Record<string, unknown>>('SELECT * FROM providers WHERE is_active = 1 LIMIT 1')
    );
  }

  private rowToProvider(row: Record<string, unknown> | undefined): LlmProvider | null {
    if (!row) return null;
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      protocol: row['protocol'] as LlmProvider['protocol'],
      baseUrl: row['base_url'] as string,
      apiKey: row['api_key'] as string,
      model: row['model'] as string,
      temperature: (row['temperature'] as number) ?? undefined,
      maxTokens: (row['max_tokens'] as number) ?? undefined,
      isActive: row['is_active'] === 1,
      source: row['source'] as LlmProvider['source'],
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }
}
