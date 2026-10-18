/**
 * In-process LLM proxy: exposes an Anthropic-Messages-compatible endpoint at
 * /_llm/v1/messages and forwards to the active provider — translating for
 * OpenAI-protocol providers, passing through for Anthropic-protocol ones.
 */
import { Router, Request, Response } from 'express';
import { ProviderRepository } from '../db/repositories/providers';
import { anthropicToOpenai, type AnthropicMessagesRequest } from './translate-request';
import { StreamTranslator, STOP_REASON, type OpenAiStreamChunk, type AnthropicSseEvent } from './translate-stream';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** OpenAI chat endpoint: bare hosts get /v1 prefix; bases already ending in /v<n> join directly
 *  (与 routes/providers.ts 连通测试的 openaiChatUrl 逻辑一致 — https://api.deepseek.com → /v1/chat/completions). */
export function openaiChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function errorBody(message: string): Record<string, unknown> {
  return { type: 'error', error: { type: 'api_error', message } };
}

function writeSse(res: Response, ev: { event: string; data: Record<string, unknown> }): void {
  res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
}

/** Write translator events; a dead client connection must never crash the process. */
function emitSse(res: Response, events: Iterable<AnthropicSseEvent>): void {
  for (const ev of events) {
    try { writeSse(res, ev); } catch { /* 客户端已断开等写失败：丢弃事件，收尾逻辑继续 */ }
  }
}

/** res.end() that never throws (client may already be gone). */
function endQuietly(res: Response): void {
  try { res.end(); } catch { /* ignore */ }
}

/** Parse an OpenAI SSE body → JSON chunks; onDone fires at [DONE] and at stream end (translator de-dupes). */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onChunk: (c: OpenAiStreamChunk) => void,
  onDone: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') { onDone(); return; }
    try { onChunk(JSON.parse(payload)); } catch { /* 跳过无法解析的行 */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer);
  onDone();
}

function openaiJsonToAnthropic(json: Record<string, any>, fallbackModel: string): Record<string, unknown> {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const content: Array<Record<string, unknown>> = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${content.length}`, name: tc.function?.name || '', input });
  }
  return {
    id: json.id || 'msg_proxy', type: 'message', role: 'assistant', model: json.model || fallbackModel,
    content,
    stop_reason: STOP_REASON[choice.finish_reason || 'stop'] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0 },
  };
}

export function createLlmProxy(repo: ProviderRepository, internalToken: string): Router {
  const router = Router();

  router.post('/v1/messages', async (req: Request, res: Response) => {
    const presented = (req.headers['x-api-key'] as string)
      || (req.headers.authorization as string || '').replace(/^Bearer\s+/i, '');
    if (presented !== internalToken) {
      return res.status(401).json(errorBody('Invalid internal token'));
    }

    const provider = repo.getActive();
    if (!provider) {
      return res.status(500).json(errorBody('未配置生效的大模型供应商，请在「模型配置」页激活'));
    }

    // ---- Anthropic 协议：透传（不修改请求体） ----
    if (provider.protocol === 'anthropic') {
      try {
        const upstream = await fetch(joinUrl(provider.baseUrl, '/v1/messages'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': (req.headers['anthropic-version'] as string) || '2023-06-01',
          },
          body: JSON.stringify(req.body),
        });
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            try { res.write(Buffer.from(value)); } catch { /* 客户端已断开 */ }
          }
        }
        endQuietly(res);
      } catch (err) {
        if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${(err as Error).message}`));
        else endQuietly(res);
      }
      return;
    }

    // ---- OpenAI 协议：转换 ----
    try {
      // 转换在 try 内：畸形请求体的抛错走 catch → 502，而非异步拒绝击穿进程
      const body = anthropicToOpenai(req.body as AnthropicMessagesRequest, {
        temperature: provider.temperature ?? undefined,
        maxTokens: provider.maxTokens ?? undefined,
      });
      const upstream = await fetch(openaiChatUrl(provider.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!upstream.ok) {
        const text = await upstream.text();
        return res.status(upstream.status).json(errorBody(`上游 ${upstream.status}: ${text.slice(0, 500)}`));
      }
      const contentType = upstream.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && upstream.body) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        const translator = new StreamTranslator();
        try {
          await consumeSse(
            upstream.body,
            chunk => emitSse(res, translator.process(chunk)),
            () => emitSse(res, translator.finish()),
          );
        } finally {
          // 截断/中断也必须以 message_delta + message_stop 收尾（finish 幂等，恰好一次）
          emitSse(res, translator.finish());
          endQuietly(res);
        }
      } else {
        const json = await upstream.json() as Record<string, any>;
        res.status(200).json(openaiJsonToAnthropic(json, (req.body as AnthropicMessagesRequest).model || ''));
      }
    } catch (err) {
      if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${(err as Error).message}`));
      else endQuietly(res);
    }
  });

  return router;
}
