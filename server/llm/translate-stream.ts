/**
 * OpenAI Chat SSE → Anthropic Messages SSE stream translation (state machine).
 * Note: message_start reports input_tokens=0 — OpenAI only sends usage in the
 * final chunk, so authoritative usage lands in message_delta.
 */

export interface OpenAiStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface AnthropicSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
};

export class StreamTranslator {
  private started = false;
  private finished = false;
  private blockIndex = -1;
  private current: 'text' | 'thinking' | 'tool' | null = null;
  private readonly toolBlocks = new Map<number, number>(); // OpenAI tool index → block index
  private inputTokens = 0;
  private outputTokens = 0;
  private stopReason = 'end_turn';
  private model = '';

  private *ensureStarted(chunk: OpenAiStreamChunk): Generator<AnthropicSseEvent> {
    if (this.started) return;
    this.started = true;
    this.model = chunk.model || '';
    yield {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: chunk.id || 'msg_proxy', type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      },
    };
  }

  private *open(type: 'text' | 'thinking' | 'tool', block: Record<string, unknown>): Generator<AnthropicSseEvent> {
    this.blockIndex++;
    this.current = type;
    yield { event: 'content_block_start', data: { type: 'content_block_start', index: this.blockIndex, content_block: block } };
  }

  private *closeCurrent(): Generator<AnthropicSseEvent> {
    if (this.current) {
      yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: this.blockIndex } };
      this.current = null;
    }
  }

  *process(chunk: OpenAiStreamChunk): Generator<AnthropicSseEvent> {
    if (this.finished) return;
    yield* this.ensureStarted(chunk);

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.reasoning_content) {
      if (this.current !== 'thinking') {
        yield* this.closeCurrent();
        yield* this.open('thinking', { type: 'thinking', thinking: '' });
      }
      yield {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } },
      };
    }

    if (delta.content) {
      if (this.current !== 'text') {
        yield* this.closeCurrent();
        yield* this.open('text', { type: 'text', text: '' });
      }
      yield {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: delta.content } },
      };
    }

    for (const tc of delta.tool_calls || []) {
      let blockIdx = this.toolBlocks.get(tc.index);
      if (blockIdx === undefined) {
        yield* this.closeCurrent();
        yield* this.open('tool', { type: 'tool_use', id: tc.id || `toolu_${tc.index}`, name: tc.function?.name || '', input: {} });
        blockIdx = this.blockIndex;
        this.toolBlocks.set(tc.index, blockIdx);
      }
      if (tc.function?.arguments) {
        yield {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } },
        };
      }
    }

    if (choice.finish_reason) {
      this.stopReason = STOP_REASON[choice.finish_reason] || 'end_turn';
      // Defer message_delta/message_stop to finish(): with stream_options.include_usage
      // a usage-only chunk (choices: []) follows finish_reason, and usage must be
      // recorded before message_delta is emitted.
      yield* this.closeCurrent();
    }
  }

  /** Close out the message: message_delta + message_stop. Idempotent; safe to call
   *  multiple times. Task 6 must call it once at stream end ([DONE]) so deferred
   *  closing events are emitted after any trailing usage-only chunk is captured. */
  *finish(): Generator<AnthropicSseEvent> {
    if (this.finished) return;
    yield* this.ensureStarted({});
    this.finished = true;
    yield* this.closeCurrent();
    yield {
      event: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: this.stopReason, stop_sequence: null }, usage: { output_tokens: this.outputTokens } },
    };
    yield { event: 'message_stop', data: { type: 'message_stop' } };
  }
}
