import { api } from './client';
import type { StepTemplate } from '../types';

export const stepApi = {
  list: (category?: string) =>
    api.get<StepTemplate[]>(`/steps${category ? `?category=${encodeURIComponent(category)}` : ''}`),

  get: (id: string) => api.get<StepTemplate>(`/steps/${id}`),

  create: (data: Partial<StepTemplate>) =>
    api.post<StepTemplate>('/steps', data),

  update: (id: string, data: Partial<StepTemplate>) =>
    api.put<StepTemplate>(`/steps/${id}`, data),

  delete: (id: string) => api.delete<void>(`/steps/${id}`),
};
