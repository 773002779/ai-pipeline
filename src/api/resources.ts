import { api } from './client';
import type { Resource, ResourceType } from '../types';

// Types for scan/import
export interface DiscoveredResource {
  name: string;
  type: 'skill' | 'agent' | 'mcp';
  description: string;
  version: string;
  source: string;
  sourcePath: string;
  config: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  alreadyImported?: boolean;
}

export interface ScanResult {
  skills: DiscoveredResource[];
  mcps: DiscoveredResource[];
}

export const resourceApi = {
  list: (type?: ResourceType) =>
    api.get<Resource[]>(`/resources${type ? `?type=${type}` : ''}`),

  get: (id: string) =>
    api.get<Resource>(`/resources/${id}`),

  create: (data: {
    type: ResourceType;
    name: string;
    description?: string;
    version?: string;
    source?: string;
    config: Record<string, unknown>;
  }) => api.post<Resource>('/resources', data),

  update: (id: string, data: Partial<Resource>) =>
    api.put<Resource>(`/resources/${id}`, data),

  delete: (id: string) =>
    api.delete<void>(`/resources/${id}`),

  toggle: (id: string) =>
    api.post<Resource>(`/resources/${id}/toggle`),

  // Scan local Claude Code for installed resources
  scanClaudeCode: () =>
    api.get<ScanResult>('/resources/scan/claude-code'),

  // List marketplace plugins
  getMarketplace: () =>
    api.get<DiscoveredResource[]>('/resources/marketplace'),

  // Import a discovered resource
  importResource: (data: {
    name: string;
    type: 'skill' | 'agent' | 'mcp';
    description?: string;
    version?: string;
    source?: string;
    sourcePath?: string;
    config: Record<string, unknown>;
  }) => api.post<Resource>('/resources/import', data),

  // Fetch plugin info from GitHub URL
  fetchGit: (url: string) =>
    api.post<DiscoveredResource>('/resources/fetch-git', { url }),

  // Scan a local directory for resource files
  scanDirectory: (dirPath: string) =>
    api.post<DiscoveredResource[]>('/resources/scan-directory', { dirPath }),
};
