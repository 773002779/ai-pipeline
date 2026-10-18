import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentManager } from '../claude/agent-manager';
import type { AgentEvent } from '../claude/agent-manager';
import type { StepTemplate } from '../../shared/types';

const queryMock = vi.mocked(query);

const template: StepTemplate = {
  id: 't1', name: '步骤', category: 'x', description: '', systemPrompt: 'sp',
  interactionMode: 'auto', autoAdvance: true, pauseForQuestions: false,
  collectActionItems: false, loopEnabled: false, outputFormat: 'markdown',
};

function baseConfig() {
  return {
    sessionId: 's1', stepId: 'p1', template,
    resolvedSkills: [], resolvedMcps: [],
    workspaces: [{ name: 'ws', path: process.cwd(), type: 'unknown' as const }],
    previousOutputs: [], requirement: 'req',
    wsChannel: { broadcastToSession: () => {} } as never,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('agent-manager usage 采集', () => {
  beforeEach(() => { queryMock.mockReset(); });

  it('从 result.usage + assistant.model 产出 usage 事件', async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: 'assistant', session_id: 'sdk-1',
        message: { model: 'deepseek-chat', role: 'assistant', content: [{ type: 'text', text: '你好' }] },
      };
      yield {
        type: 'result', subtype: 'success', session_id: 'sdk-1',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }> | undefined;
    expect(usage).toBeDefined();
    expect(usage!.model).toBe('deepseek-chat');
    expect(usage!.usage).toEqual({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5,
    });
  });

  it('result 无 usage 时不出 usage 事件', async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'sdk-1' };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    expect(events.some(e => e.type === 'usage')).toBe(false);
  });

  it('model 缺失时回退 unknown', async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: 'assistant', session_id: 'sdk-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-1', usage: { input_tokens: 1, output_tokens: 2 } };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
    expect(usage.model).toBe('unknown');
    expect(usage.usage.outputTokens).toBe(2);
  });
});
