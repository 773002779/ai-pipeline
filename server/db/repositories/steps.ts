import { DbHelper } from '../helper';
import type { SqlValue } from 'sql.js';
import type { StepTemplate } from '../../../shared/types';

interface ListFilters {
  category?: string;
}

export class StepRepository {
  constructor(private db: DbHelper) {}

  create(step: StepTemplate): StepTemplate {
    this.db.run(
      `INSERT INTO step_templates (id, name, category, description, config_json, source_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.id,
        step.name,
        step.category || '工具',
        step.description || '',
        JSON.stringify(this.toConfigJson(step)),
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      ]
    );
    return step;
  }

  getById(id: string): StepTemplate | null {
    return this.rowToStep(
      this.db.get<Record<string, unknown>>('SELECT * FROM step_templates WHERE id = ?', [id])
    );
  }

  list(filters?: ListFilters): StepTemplate[] {
    let sql = 'SELECT * FROM step_templates WHERE 1=1';
    const params: SqlValue[] = [];

    if (filters?.category) {
      sql += ' AND category = ?';
      params.push(filters.category);
    }

    sql += ' ORDER BY name';
    const rows = this.db.all<Record<string, unknown>>(sql, params);
    return rows.map((r) => this.rowToStep(r)).filter((s): s is StepTemplate => s !== null);
  }

  update(id: string, updates: Partial<StepTemplate>): StepTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };

    this.db.run(
      `UPDATE step_templates SET name=?, category=?, description=?, config_json=?, updated_at=? WHERE id=?`,
      [
        updated.name,
        updated.category,
        updated.description || '',
        JSON.stringify(this.toConfigJson(updated)),
        updated.updatedAt,
        id,
      ]
    );

    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    this.db.run('DELETE FROM step_templates WHERE id = ?', [id]);
    return true;
  }

  /** Convert StepTemplate to config_json (excludes id/name/category/description) */
  private toConfigJson(step: StepTemplate): Record<string, unknown> {
    return {
      systemPrompt: step.systemPrompt,
      model: step.model,
      maxTokens: step.maxTokens,
      tools: step.tools,
      agentId: step.agentId,
      skillIds: step.skillIds,
      mcpServerIds: step.mcpServerIds,
      resourceOverrides: step.resourceOverrides,
      interactionMode: step.interactionMode,
      autoAdvance: step.autoAdvance,
      pauseForQuestions: step.pauseForQuestions,
      collectActionItems: step.collectActionItems,
      loopEnabled: step.loopEnabled,
      defaultLoopConfig: step.defaultLoopConfig,
      inputSchema: step.inputSchema,
      outputFormat: step.outputFormat,
      outputTemplate: step.outputTemplate,
    };
  }

  private rowToStep(row: Record<string, unknown> | undefined): StepTemplate | null {
    if (!row) return null;
    const config = JSON.parse(row['config_json'] as string);
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      category: (row['category'] as string) || '工具',
      description: (row['description'] as string) || '',
      systemPrompt: config.systemPrompt || '',
      model: config.model,
      maxTokens: config.maxTokens,
      tools: config.tools,
      agentId: config.agentId,
      skillIds: config.skillIds,
      mcpServerIds: config.mcpServerIds,
      resourceOverrides: config.resourceOverrides,
      interactionMode: config.interactionMode || 'auto',
      autoAdvance: config.autoAdvance !== false,
      pauseForQuestions: config.pauseForQuestions || false,
      collectActionItems: config.collectActionItems || false,
      loopEnabled: config.loopEnabled || false,
      defaultLoopConfig: config.defaultLoopConfig,
      inputSchema: config.inputSchema,
      outputFormat: config.outputFormat || 'markdown',
      outputTemplate: config.outputTemplate,
    };
  }
}
