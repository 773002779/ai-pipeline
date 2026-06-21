import { api } from './client';
import type { Pipeline } from '../types';

export const pipelineApi = {
  list: () => api.get<Pipeline[]>('/pipelines'),
  get: (id: string) => api.get<Pipeline>(`/pipelines/${id}`),
  create: (data: { name: string; description?: string; steps: Pipeline['steps'] }) =>
    api.post<Pipeline>('/pipelines', data),
  update: (id: string, data: Partial<Pipeline>) =>
    api.put<Pipeline>(`/pipelines/${id}`, data),
  delete: (id: string) => api.delete<void>(`/pipelines/${id}`),
  validate: (id: string) =>
    api.post<{ valid: boolean; errors: string[] }>(`/pipelines/${id}/validate`),
};
