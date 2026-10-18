import { describe, it, expect } from 'vitest';
import { anthropicToOpenai } from '../llm/translate-request';

describe('anthropicToOpenai', () => {
  it('maps system, text messages and parameters', () => {
    const out = anthropicToOpenai({
      model: 'any', max_tokens: 1024, temperature: 0.5, stop_sequences: ['END'],
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: [{ type: 'text', text: 'Bye' }] },
      ],
    });
    expect(out.model).toBe('any');
    expect(out.max_tokens).toBe(1024);
    expect(out.temperature).toBe(0.5);
    expect(out.stop).toEqual(['END']);
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Bye' },
    ]);
  });

  it('maps tool_use blocks to assistant tool_calls', () => {
    const out = anthropicToOpenai({
      max_tokens: 100,
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'Running it' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
        ] },
      ],
    });
    expect(out.messages[0]).toEqual({
      role: 'assistant', content: 'Running it',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }],
    });
  });

  it('maps tool_result blocks to role:tool messages', () => {
    const out = anthropicToOpenai({
      max_tokens: 100,
      messages: [
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents here' },
          { type: 'text', text: 'Thanks' },
        ] },
      ],
    });
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents here' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('marks error tool results and joins block-array content', () => {
    const out = anthropicToOpenai({
      max_tokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] },
      ],
    });
    expect(out.messages[0].content).toBe('[error] boom');
  });

  it('maps tools and tool_choice', () => {
    const out = anthropicToOpenai({
      max_tokens: 100,
      tool_choice: { type: 'tool', name: 'Bash' },
      tools: [{ name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'Bash', description: 'Run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]);
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 'Bash' } });
  });

  it('maps tool_choice auto/any and strips cache_control/thinking', () => {
    const auto = anthropicToOpenai({ max_tokens: 1, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'x' }] });
    const any = anthropicToOpenai({ max_tokens: 1, tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'x' }] });
    expect(auto.tool_choice).toBe('auto');
    expect(any.tool_choice).toBe('required');

    const stripped = anthropicToOpenai({
      max_tokens: 1,
      system: [{ type: 'text', text: 'sys part', cache_control: { type: 'ephemeral' } }] as never,
      messages: [
        { role: 'user', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'q' }] } as never,
      ],
    });
    expect(stripped.messages[0]).toEqual({ role: 'system', content: 'sys part' });
    expect(stripped.messages[1]).toEqual({ role: 'user', content: 'q' });
    expect(JSON.stringify(stripped)).not.toContain('cache_control');
  });

  it('applies provider overrides for temperature and max_tokens', () => {
    const out = anthropicToOpenai(
      { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { temperature: 0.2, maxTokens: 2048 },
    );
    expect(out.temperature).toBe(0.2);
    expect(out.max_tokens).toBe(2048);
    // 请求自带 temperature 时不覆盖
    const keep = anthropicToOpenai(
      { model: 'm', max_tokens: 100, temperature: 0.9, messages: [{ role: 'user', content: 'x' }] },
      { temperature: 0.2 },
    );
    expect(keep.temperature).toBe(0.9);
  });
});
