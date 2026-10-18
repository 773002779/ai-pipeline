/**
 * Anthropic Messages → OpenAI Chat Completions request translation (pure).
 */

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
  cache_control?: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text?: string; cache_control?: unknown }>;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description?: string; input_schema?: object }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export function anthropicToOpenai(
  req: AnthropicMessagesRequest,
  overrides?: { temperature?: number; maxTokens?: number },
): OpenAiChatRequest {
  const out: OpenAiChatRequest = {
    model: req.model || '',
    messages: [],
    stream: !!req.stream,
  };
  if (req.stream) out.stream_options = { include_usage: true };

  // 供应商级覆盖：temperature 仅在请求未携带时生效，max_tokens 优先生效
  const maxTokens = overrides?.maxTokens ?? req.max_tokens;
  if (maxTokens) out.max_tokens = maxTokens;
  const temperature = req.temperature ?? overrides?.temperature;
  if (temperature !== undefined) out.temperature = temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  const system = typeof req.system === 'string'
    ? req.system
    : Array.isArray(req.system)
      ? req.system.map(b => b.text || '').join('\n')
      : undefined;
  if (system) out.messages.push({ role: 'system', content: system });

  for (const m of req.messages || []) {
    const blocks: AnthropicContentBlock[] = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : m.content;

    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      out.messages.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length > 0 && {
          tool_calls: toolUses.map(t => ({
            id: t.id || `toolu_${out.messages.length}`,
            type: 'function' as const,
            function: { name: t.name || '', arguments: JSON.stringify(t.input ?? {}) },
          })),
        }),
      });
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const content = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map(c => c.text || '').join('')
              : '';
          out.messages.push({
            role: 'tool',
            tool_call_id: b.tool_use_id || '',
            content: b.is_error ? `[error] ${content}` : content,
          });
        } else if (b.type === 'text') {
          out.messages.push({ role: 'user', content: b.text || '' });
        }
        // thinking / 其他块：跳过
      }
    }
  }

  if (req.tools?.length) {
    out.tools = req.tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
  }

  if (req.tool_choice) {
    if (req.tool_choice.type === 'auto') out.tool_choice = 'auto';
    else if (req.tool_choice.type === 'none') out.tool_choice = 'none';
    else if (req.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (req.tool_choice.type === 'tool' && req.tool_choice.name) {
      out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
    }
  }

  return out;
}
