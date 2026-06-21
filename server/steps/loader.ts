import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { StepRepository } from '../db/repositories/steps';
import type { StepTemplate } from '../../shared/types';

const DEFAULT_STEPS_DIR = path.join(process.cwd(), '.pipeline', 'steps');

export class StepLoader {
  constructor(private repo: StepRepository) {}

  /** Load all YAML step definitions from the steps directory into the database */
  loadFromDirectory(dirPath: string = DEFAULT_STEPS_DIR): number {
    if (!fs.existsSync(dirPath)) {
      return 0;
    }

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    let loaded = 0;

    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(content) as Record<string, unknown>;

        if (!parsed || !parsed.name || !parsed.systemPrompt) {
          console.warn(`Skipping invalid step file: ${file}`);
          continue;
        }

        const step: StepTemplate = {
          id: (parsed.id as string) || this.generateId(parsed.name as string),
          name: parsed.name as string,
          category: (parsed.category as string) || '工具',
          description: (parsed.description as string) || '',
          systemPrompt: parsed.systemPrompt as string,
          model: parsed.model as string | undefined,
          maxTokens: parsed.maxTokens as number | undefined,
          tools: parsed.tools as string[] | undefined,
          agentId: parsed.agentId as string | undefined,
          skillIds: parsed.skillIds as string[] | undefined,
          mcpServerIds: parsed.mcpServerIds as string[] | undefined,
          resourceOverrides: parsed.resourceOverrides as StepTemplate['resourceOverrides'],
          interactionMode: (parsed.interactionMode as StepTemplate['interactionMode']) || 'auto',
          autoAdvance: (parsed.autoAdvance as boolean) !== false,
          pauseForQuestions: (parsed.pauseForQuestions as boolean) || false,
          collectActionItems: (parsed.collectActionItems as boolean) || false,
          loopEnabled: (parsed.loopEnabled as boolean) || false,
          defaultLoopConfig: parsed.defaultLoopConfig as StepTemplate['defaultLoopConfig'],
          inputSchema: parsed.inputSchema as Record<string, unknown>,
          outputFormat: (parsed.outputFormat as 'markdown' | 'json' | 'text') || 'markdown',
          outputTemplate: parsed.outputTemplate as string | undefined,
        };

        // Upsert: try update first, then create
        const existing = this.repo.getById(step.id);
        if (existing) {
          this.repo.update(step.id, step);
        } else {
          this.repo.create(step);
        }
        loaded++;
      } catch (err) {
        console.error(`Error loading step file ${file}:`, (err as Error).message);
      }
    }

    return loaded;
  }

  private generateId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `builtin-${slug}`;
  }
}
