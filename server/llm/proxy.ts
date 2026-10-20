/**
 * In-process LLM proxy: exposes an Anthropic-Messages-compatible endpoint at
 * /_llm/v1/messages and forwards to the active provider — translating for
 * OpenAI-protocol providers, passing through for Anthropic-protocol ones.
 *
 * 上游请求带两道超时：响应头超时（连接黑洞）与流式空闲超时（响应中途静默），
 * 二者任一触发即中止上游请求并向 SDK 返回 502 —— 否则一轮对话会永久挂起。
 */
import { Router, Request, Response } from 'express';
import { ProviderRepository } from '../db/repositories/providers';
import { anthropicToOpenai, type AnthropicMessagesRequest } from './translate-request';
import { StreamTranslator, STOP_REASON, type OpenAiStreamChunk, type AnthropicSseEvent } from './translate-stream';

export interface LlmProxyTimeouts {
  /** 上游响应头超时（ms） */
  connectTimeoutMs?: number;
  /** 流式响应空闲超时（ms）：相邻两段数据之间的最大间隔 */
  idleTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** OpenAI chat endpoint: bare hosts get /v1 prefix; bases already ending in /v<n> join directly
 *  (与 routes/providers.ts 连通测试的 openaiChatUrl 逻辑一致 — https://api.deepseek.com → /v1/chat/completions).
 *  baseUrl 若已带 /chat/completions 完整路径则原样返回，避免二次拼接。 */
export function openaiChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** 上游超时守卫：连接超时 → fetch 前生效；空闲超时 → 每收到一段数据时 touch() 续期。 */
interface UpstreamGuard {
  signal: AbortSignal;
  /** fetch 已拿到响应头，解除连接超时 */
  connected(): void;
  /** 收到一段上游数据，续期空闲超时 */
  touch(): void;
  /** 收尾清理全部计时器（成功与异常路径都必须调用） */
  done(): void;
  /** 触发过的超时描述（未触发为 null） */
  timedOut: string | null;
}

function createUpstreamGuard(connectTimeoutMs: number, idleTimeoutMs: number): UpstreamGuard {
  const controller = new AbortController();
  let timedOut: string | null = null;
  let connectTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const abortWith = (msg: string) => {
    timedOut = msg;
    controller.abort(new Error(msg));
  };
  connectTimer = setTimeout(
    () => abortWith(`上游连接超时（${Math.round(connectTimeoutMs / 1000)}s 内未收到响应头）`),
    connectTimeoutMs,
  );
  return {
    signal: controller.signal,
    connected() { clearTimeout(connectTimer); },
    touch() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abortWith(`上游响应空闲超时（${Math.round(idleTimeoutMs / 1000)}s 内无数据）`),
        idleTimeoutMs,
      );
    },
    done() { clearTimeout(connectTimer); clearTimeout(idleTimer); },
    get timedOut() { return timedOut; },
  };
}

/** 从 abort 异常中提取可读原因（abort reason 可能在 message 或 cause 上） */
function upstreamErrorMessage(err: unknown): string {
  const cause = (err as { cause?: Error })?.cause;
  return cause?.message || (err as Error).message || '未知错误';
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

/** Parse an OpenAI SSE body → JSON chunks; onDone fires at [DONE] and at stream end (translator de-dupes).
 *  onData 在每段原始字节到达时回调（用于空闲超时续期）。 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: () => void,
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
    onData();
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

export function createLlmProxy(repo: ProviderRepository, internalToken: string, timeouts?: LlmProxyTimeouts): Router {
  const connectTimeoutMs = timeouts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = timeouts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
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
    const guard = createUpstreamGuard(connectTimeoutMs, idleTimeoutMs);

    // ---- Anthropic 协议：透传（不修改请求体） ----
    if (provider.protocol === 'anthropic') {
      try {
        const upstream = await fetch(joinUrl(provider.baseUrl, '/v1/messages'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': (req.headers['anthropic-version'] as string) || '2023-06-01',
            ...(provider.headers ?? {}),
          },
          body: JSON.stringify(req.body),
          signal: guard.signal,
        });
        guard.connected();
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            guard.touch();
            const { done, value } = await reader.read();
            if (done) break;
            try { res.write(Buffer.from(value)); } catch { /* 客户端已断开 */ }
          }
        }
        endQuietly(res);
      } catch (err) {
        if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${upstreamErrorMessage(err)}`));
        else endQuietly(res);
      } finally {
        guard.done();
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: guard.signal,
      });
      guard.connected();
      if (!upstream.ok) {
        guard.touch();
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
            () => guard.touch(),
            chunk => emitSse(res, translator.process(chunk)),
            () => emitSse(res, translator.finish()),
          );
        } finally {
          // 截断/中断也必须以 message_delta + message_stop 收尾（finish 幂等，恰好一次）
          emitSse(res, translator.finish());
          endQuietly(res);
        }
      } else {
        guard.touch();
        const json = await upstream.json() as Record<string, any>;
        res.status(200).json(openaiJsonToAnthropic(json, (req.body as AnthropicMessagesRequest).model || ''));
      }
    } catch (err) {
      if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${upstreamErrorMessage(err)}`));
      else endQuietly(res);
    } finally {
      guard.done();
    }
  });

  return router;
}
