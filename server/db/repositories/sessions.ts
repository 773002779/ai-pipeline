import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';
import type { SqlValue } from 'sql.js';
import type { Session, SessionStep, ActionItem } from '../../../shared/types';

export class SessionRepository {
  constructor(private db: DbHelper) {}

  create(session: Session): Session {
    this.db.run(
      `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status,
        workspaces_json, environment_json, current_step_index, step_overrides_json,
        chat_sdk_session_id, chat_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, session.pipelineId, JSON.stringify(session.pipelineSnapshot), session.name,
        session.requirement, session.status, JSON.stringify(session.workspaces),
        session.environment ? JSON.stringify(session.environment) : null,
        session.currentStepIndex, session.stepOverrides ? JSON.stringify(session.stepOverrides) : null,
        session.chatSdkSessionId ?? null, session.chatModel ?? null,
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
      chatSdkSessionId: (row['chat_sdk_session_id'] as string) || undefined,
      chatModel: (row['chat_model'] as string) || undefined,
      chatSummary: (row['chat_summary'] as string) || undefined,
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
      startedAt: (r['started_at'] as string) || undefined,
      completedAt: (r['completed_at'] as string) || undefined,
      outputPath: (r['output_path'] as string) || undefined,
      errorMessage: (r['error_message'] as string) || undefined,
      retryCount: r['retry_count'] as number,
    }));
  }

  list(filters?: { status?: string }): Session[] {
    let sql = 'SELECT id FROM sessions WHERE 1=1';
    const params: SqlValue[] = [];
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
    const order = stepIndex + 1;
    const current = this.db.get<Record<string, unknown>>(
      'SELECT * FROM session_steps WHERE session_id = ? AND step_order = ?',
      [sessionId, order],
    );
    if (!current) return;

    // Fields absent from `extra` keep their current value; an explicit
    // undefined clears the stored value (used by retry to reset state).
    const pick = (key: keyof SessionStep, fallback: SqlValue | null): SqlValue | null =>
      extra && key in extra ? ((extra[key] as unknown as SqlValue) ?? null) : fallback;

    this.db.run(
      `UPDATE session_steps SET status=?, started_at=?, completed_at=?, output_path=?, error_message=?, retry_count=?
       WHERE session_id=? AND step_order=?`,
      [
        status,
        pick('startedAt', current['started_at'] as SqlValue | null),
        pick('completedAt', current['completed_at'] as SqlValue | null),
        pick('outputPath', current['output_path'] as SqlValue | null),
        pick('errorMessage', current['error_message'] as SqlValue | null),
        pick('retryCount', current['retry_count'] as SqlValue | null),
        sessionId,
        order,
      ]
    );
  }

  updateChatFields(id: string, fields: { chatSdkSessionId?: string; chatModel?: string; chatSummary?: string }): Session | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    this.db.run(
      'UPDATE sessions SET chat_sdk_session_id=?, chat_model=?, chat_summary=?, updated_at=? WHERE id=?',
      [updated.chatSdkSessionId ?? null, updated.chatModel ?? null, updated.chatSummary ?? null, updated.updatedAt, id]
    );
    return updated;
  }

  /** /clear：清空 SDK 会话句柄与压缩摘要（保留聊天记录与会话级模型选择） */
  resetChatContext(id: string): void {
    this.updateChatFields(id, { chatSdkSessionId: undefined, chatSummary: undefined });
  }

  /** 首条用户消息回填会话标题与 requirement（chat 会话专用；已有内容则跳过） */
  applyFirstMessage(id: string, content: string): void {
    const existing = this.getById(id);
    if (!existing || existing.requirement) return;
    this.db.run(
      'UPDATE sessions SET name=?, requirement=?, updated_at=? WHERE id=?',
      [content.slice(0, 20) || '新对话', content, new Date().toISOString(), id]
    );
  }

  listByPipeline(pipelineId: string): Session[] {
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE pipeline_id = ? ORDER BY updated_at DESC', [pipelineId]
    );
    return rows.map(r => this.getById(r.id)).filter((s): s is Session => s !== null);
  }

  deleteCascade(id: string): boolean {
    if (!this.getById(id)) return false;
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM usage_records WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM permission_whitelist WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM action_items WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM session_steps WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return true;
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
