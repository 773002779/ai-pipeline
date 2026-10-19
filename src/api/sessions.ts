import { api } from './client';
import type { Session, ActionItem, Message } from '../types';

export const sessionApi = {
  list: (status?: string) => api.get<Session[]>(`/sessions${status ? `?status=${status}` : ''}`),
  get: (id: string) => api.get<Session>(`/sessions/${id}`),
  create: (data: { pipelineId: string; name: string; requirement: string; workspaces: { name: string; path: string; type: string }[]; stepOverrides?: Record<string, unknown> }) =>
    api.post<Session>('/sessions', data),
  precheck: (id: string) => api.post<Session>(`/sessions/${id}/precheck`),
  start: (id: string) => api.post<Session>(`/sessions/${id}/start`),
  pause: (id: string) => api.post<Session>(`/sessions/${id}/pause`),
  resume: (id: string) => api.post<Session>(`/sessions/${id}/resume`),
  cancel: (id: string) => api.post<Session>(`/sessions/${id}/cancel`),
  retry: (id: string) => api.post<Session>(`/sessions/${id}/retry`),
  clone: (id: string) => api.post<Session>(`/sessions/${id}/clone`),
  delete: (id: string) => api.delete<void>(`/sessions/${id}`),
  getActionItems: (id: string) => api.get<ActionItem[]>(`/sessions/${id}/action-items`),
  getMessages: (id: string) => api.get<Message[]>(`/sessions/${id}/messages`),
  sendMessage: (id: string, content: string, stepId?: string) =>
    api.post<Message>(`/sessions/${id}/messages`, { content, stepId }),
};
