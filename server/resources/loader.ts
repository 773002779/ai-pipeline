import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ResourceRepository } from '../db/repositories/resources';
import type { Resource, ResourceType } from '../../shared/types';

const DEFAULT_RESOURCES_DIR = path.join(process.cwd(), '.pipeline', 'resources');

export class ResourceLoader {
  constructor(private repo: ResourceRepository) {}

  /** Load all YAML resource definitions from resources/{skills,agents,mcp}/ into the database */
  loadFromDirectory(dirPath: string = DEFAULT_RESOURCES_DIR): number {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    let loaded = 0;
    const typeMap: Record<string, ResourceType> = {
      skills: 'skill',
      agents: 'agent',
      mcp: 'mcp',
    };

    for (const [subDir, type] of Object.entries(typeMap)) {
      const fullPath = path.join(dirPath, subDir);
      if (!fs.existsSync(fullPath)) continue;

      const files = fs.readdirSync(fullPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const file of files) {
        try {
          const filePath = path.join(fullPath, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = yaml.load(content) as Record<string, unknown>;

          if (!parsed || !parsed.name) continue;

          const resource: Resource = {
            id: (parsed.id as string) || this.generateId(type, parsed.name as string),
            type,
            name: parsed.name as string,
            description: (parsed.description as string) || '',
            version: (parsed.version as string) || '1.0.0',
            source: (parsed.source as Resource['source']) || 'builtin',
            config: (parsed.config as Resource['config']) || {},
            enabled: (parsed.enabled as boolean) !== false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          const existing = this.repo.getById(resource.id);
          if (existing) {
            this.repo.update(resource.id, resource);
          } else {
            this.repo.create(resource);
          }
          loaded++;
        } catch (err) {
          console.error(`Error loading resource ${file}:`, (err as Error).message);
        }
      }
    }

    return loaded;
  }

  private generateId(type: ResourceType, name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `builtin-${type}-${slug}`;
  }
}
