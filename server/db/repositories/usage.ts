import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';

export interface UsageRecordInput {
  sessionId: string;
  stepId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export class UsageRepository {
  constructor(private db: DbHelper) {}

  add(record: UsageRecordInput): void {
    this.db.run(
      `INSERT INTO usage_records (id, session_id, step_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), record.sessionId, record.stepId ?? null, record.model,
        record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens]
    );
  }
}
