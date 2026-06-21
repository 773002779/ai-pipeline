import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';
import type { Session, SessionStep, ActionItem } from '../../../shared/types';

export class SessionRepository {
  constructor(private db: DbHelper) {}

  create(session: Session): Session {
    this.db.run(
      `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status,
        workspaces_json, environment_json, current_step_index, step_overrides_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, session.pipelineId, JSON.stringify(session.pipelineSnapshot), session.name,
        session.requirement, session.status, JSON.stringify(session.workspaces),
        session.environment ? JSON.stringify(session.environment) : null,
        session.currentStepIndex, session.stepOverrides ? JSON.stringify(session.stepOverrides) : null,
        session.createdAt, session.updatedAt]
    );
    // Create session steps
    for (const step of session.steps) {
      this.db.run(
        `INSERT INTO session_steps (session_id, template_id, step_name, step_order, status)
         VALUES (?, ?, ?, ?, ?)`,
        [session.id, step.templateId, step.stepName, session.steps.indexOf(step) + 1, step.status]
      );
    }
    return session;
  }

  getById(id: string): Session | null {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) return null;
    const session: Session = {
      id: row['id'] as string,
      pipelineId: row['pipeline_id'] as string,
      pipelineSnapshot: JSON.parse(row['pipeline_snapshot'] as string),
      name: row['name'] as string,
      requirement: row['requirement'] as string,
      status: row['status'] as Session['status'],
      workspaces: JSON.parse(row['workspaces_json'] as string),
      environment: row['environment_json'] ? JSON.parse(row['environment_json'] as string) : undefined,
      currentStepIndex: row['current_step_index'] as number,
      steps: this.getSessionSteps(id),
      stepOverrides: row['step_overrides_json'] ? JSON.parse(row['step_overrides_json'] as string) : undefined,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
    return session;
  }

  private getSessionSteps(sessionId: string): SessionStep[] {
    return this.db.all<Record<string, unknown>>(
      'SELECT * FROM session_steps WHERE session_id = ? ORDER BY step_order', [sessionId]
    ).map(r => ({
      templateId: r['template_id'] as string,
      stepName: r['step_name'] as string,
      status: r['status'] as SessionStep['status'],
      startedAt: r['started_at'] as string | undefined,
      completedAt: r['completed_at'] as string | undefined,
      outputPath: r['output_path'] as string | undefined,
      errorMessage: r['error_message'] as string | undefined,
      retryCount: r['retry_count'] as number,
    }));
  }

  list(filters?: { status?: string }): Session[] {
    let sql = 'SELECT id FROM sessions WHERE 1=1';
    const params: unknown[] = [];
    if (filters?.status) { sql += ' AND status = ?'; params.push(filters.status); }
    sql += ' ORDER BY updated_at DESC';
    const rows = this.db.all<{ id: string }>(sql, params);
    return rows.map(r => this.getById(r.id)).filter((s): s is Session => s !== null);
  }

  updateStatus(id: string, status: Session['status'], extra?: Partial<Session>): Session | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const updated = { ...existing, ...extra, status, updatedAt: new Date().toISOString() };
    this.db.run(
      `UPDATE sessions SET status=?, current_step_index=?, environment_json=?, updated_at=? WHERE id=?`,
      [status, updated.currentStepIndex,
        updated.environment ? JSON.stringify(updated.environment) : null,
        updated.updatedAt, id]
    );
    return updated;
  }

  updateStepStatus(sessionId: string, stepIndex: number, status: SessionStep['status'], extra?: Partial<SessionStep>): void {
    const stepName = this.getSessionSteps(sessionId)[stepIndex]?.stepName;
    if (!stepName) return;
    this.db.run(
      `UPDATE session_steps SET status=?, started_at=?, completed_at=?, output_path=?, error_message=?, retry_count=?
       WHERE session_id=? AND step_name=?`,
      [status, extra?.startedAt || null, extra?.completedAt || null, extra?.outputPath || null,
        extra?.errorMessage || null, extra?.retryCount || 0, sessionId, stepName]
    );
  }

  addActionItem(item: ActionItem): void {
    this.db.run(
      `INSERT INTO action_items (id, session_id, step_id, severity, title, description, file_path, line_number, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.sessionId, item.stepId, item.severity, item.title, item.description || '',
        item.file || null, item.line || null, item.status]
    );
  }

  getActionItems(sessionId: string): ActionItem[] {
    return this.db.all<Record<string, unknown>>(
      "SELECT * FROM action_items WHERE session_id = ? ORDER BY severity, created_at", [sessionId]
    ).map(r => ({
      id: r['id'] as string, sessionId: r['session_id'] as string, stepId: r['step_id'] as string,
      severity: r['severity'] as ActionItem['severity'], title: r['title'] as string,
      description: (r['description'] as string) || '', file: r['file_path'] as string | undefined,
      line: r['line_number'] as number | undefined,
      status: r['status'] as ActionItem['status'], resolution: r['resolution'] as string | undefined,
      createdAt: r['created_at'] as string,
    }));
  }

  addMessage(sessionId: string, stepId: string | null, role: string, content: string, thinking?: string): void {
    const id = uuidv4();
    this.db.run(
      `INSERT INTO messages (id, session_id, step_id, role, content, thinking_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sessionId, stepId, role, content, thinking ? JSON.stringify(thinking) : null]
    );
  }
}
