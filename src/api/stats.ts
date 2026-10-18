import { api } from './client';

export interface StatsOverview {
  resources: number;
  pipelines: number;
  sessionsTotal: number;
  sessionsByStatus: Record<string, number>;
}
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}
export interface DailyUsage { date: string; model: string; tokens: number; }
export interface TopSession {
  sessionId: string;
  name: string;
  kind: 'pipeline' | 'chat';
  totalTokens: number;
}
export interface UsageStats {
  models: ModelUsage[];
  daily: DailyUsage[];
  topSessions: TopSession[];
}

export const statsApi = {
  overview: () => api.get<StatsOverview>('/stats/overview'),
  usage: (range: { from: string; to: string }) =>
    api.get<UsageStats>(`/stats/usage?from=${range.from}&to=${range.to}`),
};
