import { api } from './client';
import type { LlmProvider, LlmProtocol } from '../types';

export interface ProviderInput {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ContinueImportResult {
  imported: LlmProvider[];
  skipped: number;
  errors: string[];
}

export const providerApi = {
  list: () => api.get<LlmProvider[]>('/providers'),
  create: (data: ProviderInput) => api.post<LlmProvider>('/providers', data),
  update: (id: string, data: Partial<ProviderInput>) => api.put<LlmProvider>(`/providers/${id}`, data),
  remove: (id: string) => api.delete<{ deleted: boolean }>(`/providers/${id}`),
  activate: (id: string) => api.post<LlmProvider>(`/providers/${id}/activate`),
  test: (id: string) => api.post<TestResult>(`/providers/${id}/test`),
  importContinue: (configPath?: string) =>
    api.post<ContinueImportResult>('/providers/import-continue', { configPath }),
};
