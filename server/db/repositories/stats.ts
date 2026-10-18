import { DbHelper } from '../helper';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../../shared/types';

const TOKEN_SUM = "SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)";

export class StatsRepository {
  constructor(private db: DbHelper) {}

  overview(): { resources: number; pipelines: number; sessionsTotal: number; sessionsByStatus: Record<string, number> } {
    const resources = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM resources')?.n ?? 0;
    const pipelines = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pipelines WHERE id != ?', [BUILTIN_CHAT_PIPELINE_ID])?.n ?? 0;
    const statusRows = this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM sessions GROUP BY status');
    const sessionsByStatus: Record<string, number> = {};
    let sessionsTotal = 0;
    for (const r of statusRows) { sessionsByStatus[r.status] = r.n; sessionsTotal += r.n; }
    return { resources, pipelines, sessionsTotal, sessionsByStatus };
  }

  modelUsage(from: string, to: string): Array<{ model: string; inputTokens: number; outputTokens: number; cacheTokens: number; totalTokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT model,
              SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens,
              SUM(cache_read_tokens + cache_creation_tokens) AS cacheTokens,
              ${TOKEN_SUM} AS totalTokens
       FROM usage_records
       WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY model
       ORDER BY totalTokens DESC`,
      [from, to],
    ).map(r => ({
      model: r['model'] as string,
      inputTokens: Number(r['inputTokens'] ?? 0),
      outputTokens: Number(r['outputTokens'] ?? 0),
      cacheTokens: Number(r['cacheTokens'] ?? 0),
      totalTokens: Number(r['totalTokens'] ?? 0),
    }));
  }

  dailyUsage(from: string, to: string): Array<{ date: string; model: string; tokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT date(created_at, 'localtime') AS date, model, ${TOKEN_SUM} AS tokens
       FROM usage_records
       WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(created_at, 'localtime'), model
       ORDER BY date`,
      [from, to],
    ).map(r => ({
      date: r['date'] as string,
      model: r['model'] as string,
      tokens: Number(r['tokens'] ?? 0),
    }));
  }

  topSessions(from: string, to: string, limit = 5): Array<{ sessionId: string; name: string; kind: 'pipeline' | 'chat'; totalTokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT ur.session_id AS sessionId, s.name AS name, s.pipeline_id AS pipelineId, ${TOKEN_SUM} AS totalTokens
       FROM usage_records ur
       JOIN sessions s ON s.id = ur.session_id
       WHERE date(ur.created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY ur.session_id
       ORDER BY totalTokens DESC
       LIMIT ?`,
      [from, to, limit],
    ).map(r => ({
      sessionId: r['sessionId'] as string,
      name: (r['name'] as string) || '',
      kind: r['pipelineId'] === BUILTIN_CHAT_PIPELINE_ID ? 'chat' as const : 'pipeline' as const,
      totalTokens: Number(r['totalTokens'] ?? 0),
    }));
  }
}
