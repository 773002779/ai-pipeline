import { DbHelper } from '../helper';
import type { Pipeline } from '../../../shared/types';

export class PipelineRepository {
  constructor(private db: DbHelper) {}

  create(pipeline: Pipeline): Pipeline {
    this.db.run(
      `INSERT INTO pipelines (id, name, description, definition_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [pipeline.id, pipeline.name, pipeline.description || '', JSON.stringify(pipeline),
        pipeline.createdAt, pipeline.updatedAt]
    );
    return pipeline;
  }

  getById(id: string): Pipeline | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM pipelines WHERE id = ?', [id]);
    return row ? (JSON.parse(row['definition_json'] as string) as Pipeline) : null;
  }

  list(): Pipeline[] {
    const rows = this.db.all<Record<string, unknown>>('SELECT * FROM pipelines ORDER BY updated_at DESC');
    return rows.map(r => JSON.parse(r['definition_json'] as string) as Pipeline);
  }

  update(id: string, updates: Partial<Pipeline>): Pipeline | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    this.db.run(
      `UPDATE pipelines SET name=?, description=?, definition_json=?, updated_at=? WHERE id=?`,
      [updated.name, updated.description || '', JSON.stringify(updated), updated.updatedAt, id]
    );
    return updated;
  }

  delete(id: string): boolean {
    if (!this.getById(id)) return false;
    this.db.run('DELETE FROM pipelines WHERE id = ?', [id]);
    return true;
  }

  validate(pipeline: Pipeline): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!pipeline.name?.trim()) errors.push('名称不能为空');
    // 空步骤是合法的——用户先创建流水线，再在编辑器中配置步骤
    pipeline.steps?.forEach((s, i) => {
      if (!s.templateId) errors.push(`步骤 ${i + 1}: 缺少 templateId`);
    });
    return { valid: errors.length === 0, errors };
  }
}
