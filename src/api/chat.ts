import { api } from './client';
import type { Session, FsNode } from '../types';

export const chatApi = {
  list: () => api.get<Session[]>('/chat/sessions'),
  create: (data: { workspaces: { name: string; path: string; type: string }[]; model?: string }) =>
    api.post<Session>('/chat/sessions', data),
  remove: (id: string) => api.delete<void>(`/chat/${id}`),
  setModel: (id: string, model?: string) => api.put<Session>(`/chat/${id}/model`, { model }),
  sendMessage: (id: string, content: string) => api.post<void>(`/chat/${id}/messages`, { content }),
  stop: (id: string) => api.post<void>(`/chat/${id}/stop`),
};

export const fsApi = {
  tree: (root: string) => api.get<FsNode>(`/fs/tree?root=${encodeURIComponent(root)}`),
};
