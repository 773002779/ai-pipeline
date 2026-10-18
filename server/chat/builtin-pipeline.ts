import { DbHelper } from '../db/helper';
import { PipelineRepository } from '../db/repositories/pipelines';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Pipeline } from '../../shared/types';

/** 幂等创建内置「自由对话」流水线；已存在则原样返回 */
export function ensureBuiltinChatPipeline(db: DbHelper): Pipeline {
  const repo = new PipelineRepository(db);
  const existing = repo.getById(BUILTIN_CHAT_PIPELINE_ID);
  if (existing) return existing;
  const now = new Date().toISOString();
  return repo.create({
    id: BUILTIN_CHAT_PIPELINE_ID,
    name: '自由对话',
    description: '内置：Claude 对话页专用（不可编辑）',
    steps: [],
    createdAt: now,
    updatedAt: now,
  });
}
