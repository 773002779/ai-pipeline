import { describe, it, expect } from 'vitest';
import { StreamTranslator, type AnthropicSseEvent, type OpenAiStreamChunk } from '../llm/translate-stream';

function collect(gen: Generator<AnthropicSseEvent>): AnthropicSseEvent[] {
  return [...gen];
}

function textChunk(content: string, extra: object = {}): OpenAiStreamChunk {
  return { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ delta: { content }, ...extra }] } as OpenAiStreamChunk;
}

function eventsOf(seq: OpenAiStreamChunk[]): AnthropicSseEvent[] {
  const t = new StreamTranslator();
  const out: AnthropicSseEvent[] = [];
  for (const c of seq) out.push(...collect(t.process(c)));
  out.push(...collect(t.finish()));
  return out;
}

describe('StreamTranslator', () => {
  it('emits message_start → text deltas → message_stop for a text stream', () => {
    const events = eventsOf([textChunk('你好'), textChunk('世界')]);
    expect(events[0].event).toBe('message_start');
    const types = events.map(e => e.event);
    expect(types.filter(t => t === 'content_block_start')).toHaveLength(1);
    expect(types.filter(t => t === 'content_block_delta')).toHaveLength(2);
    expect(events[events.length - 1].event).toBe('message_stop');
    const deltas = events.filter(e => e.event === 'content_block_delta');
    expect(deltas[0].data.delta).toEqual({ type: 'text_delta', text: '你好' });
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect((msgDelta!.data.delta as { stop_reason: string }).stop_reason).toBe('end_turn');
  });

  it('opens a thinking block for reasoning_content then switches back to text', () => {
    const events = eventsOf([
      { choices: [{ delta: { reasoning_content: '让我想想' } }] } as OpenAiStreamChunk,
      { choices: [{ delta: { reasoning_content: '…' } }] } as OpenAiStreamChunk,
      textChunk('答案'),
    ]);
    const starts = events.filter(e => e.event === 'content_block_start');
    expect((starts[0].data.content_block as { type: string }).type).toBe('thinking');
    expect((starts[1].data.content_block as { type: string }).type).toBe('text');
    const thinkingDelta = events.find(e => (e.data.delta as { type?: string })?.type === 'thinking_delta');
    expect((thinkingDelta!.data.delta as { thinking: string }).thinking).toBe('让我想想');
    // thinking 块在切回文本前已关闭
    const stops = events.filter(e => e.event === 'content_block_stop');
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  it('aggregates tool call fragments into a tool_use block with input_json_delta', () => {
    const events = eventsOf([
      textChunk('好的，执行'),
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } }] } }] } as OpenAiStreamChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] } as unknown as OpenAiStreamChunk,
      { choices: [{ finish_reason: 'tool_calls' }] } as OpenAiStreamChunk,
    ]);
    const toolStart = events.find(e => (e.data.content_block as { type?: string })?.type === 'tool_use');
    expect(toolStart!.data.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'Bash' });
    const jsonDeltas = events.filter(e => (e.data.delta as { type?: string })?.type === 'input_json_delta');
    const joined = jsonDeltas.map(e => (e.data.delta as { partial_json: string }).partial_json).join('');
    expect(joined).toBe('{"command":"ls"}');
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect((msgDelta!.data.delta as { stop_reason: string }).stop_reason).toBe('tool_use');
  });

  it('emits two blocks for parallel tool calls', () => {
    const events = eventsOf([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call_a', function: { name: 'Read', arguments: '{}' } },
        { index: 1, id: 'call_b', function: { name: 'Grep', arguments: '{}' } },
      ] } }] } as OpenAiStreamChunk,
      { choices: [{ finish_reason: 'tool_calls' }] } as OpenAiStreamChunk,
    ]);
    const toolStarts = events.filter(e => (e.data.content_block as { type?: string })?.type === 'tool_use');
    expect(toolStarts).toHaveLength(2);
    expect((toolStarts[0].data.content_block as { name: string }).name).toBe('Read');
    expect((toolStarts[1].data.content_block as { name: string }).name).toBe('Grep');
  });

  it('maps length finish_reason to max_tokens stop reason', () => {
    const events = eventsOf([
      textChunk('x'),
      { choices: [{ finish_reason: 'length' }] } as OpenAiStreamChunk,
    ]);
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect((msgDelta!.data.delta as { stop_reason: string }).stop_reason).toBe('max_tokens');
  });

  it('finish() is idempotent and handles empty upstream', () => {
    const t = new StreamTranslator();
    const once = collect(t.finish());
    const twice = collect(t.finish());
    expect(once.map(e => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(twice).toEqual([]);
  });

  it('records usage when provided', () => {
    const events = eventsOf([
      textChunk('x'),
      { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } } as OpenAiStreamChunk,
    ]);
    const start = events[0];
    expect((start.data.message as { usage: { input_tokens: number } }).usage.input_tokens).toBe(11);
    const msgDelta = events.find(e => e.event === 'message_delta');
    expect((msgDelta!.data.usage as { output_tokens: number }).output_tokens).toBe(7);
  });
});
