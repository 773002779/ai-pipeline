import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ProviderRepository } from '../db/repositories/providers';
import { createLlmProxy, openaiChatUrl } from '../llm/proxy';
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase;
let repo: ProviderRepository;
let appServer: http.Server;
let upstream: http.Server;
let appUrl: string;
let upstreamUrl: string;
let lastChatHeaders: http.IncomingHttpHeaders = {};

const ANTHROPIC_REQ = {
  model: 'deepseek-chat', max_tokens: 100, stream: false,
  messages: [{ role: 'user', content: '你好' }],
};

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  repo = new ProviderRepository(new DbHelper(db));

  // Mock OpenAI upstream: streaming SSE + non-stream JSON
  const up = express();
  up.use(express.json());
  up.post('/v1/chat/completions', (req, res) => {
    lastChatHeaders = req.headers;
    if (req.body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = [
        { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ delta: { content: '你好' } }] },
        { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] } }] },
        { id: 'chatcmpl-1', model: 'deepseek-chat', choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 9 } },
      ];
      for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({ id: 'cmpl-1', model: 'deepseek-chat', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    }
  });
  // Mock Anthropic passthrough upstream: echoes what it received
  up.post('/v1/messages', (req, res) => {
    res.json({ echo: req.body, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], type: req.headers['type'] });
  });
  await new Promise<void>(r => { upstream = up.listen(0, () => r()); });
  upstreamUrl = `http://localhost:${(upstream.address() as { port: number }).port}`;

  const app = express();
  app.use(express.json());
  app.use('/_llm', createLlmProxy(repo, 'tok-internal-1'));
  await new Promise<void>(r => {
    appServer = app.listen(0, () => {
      appUrl = `http://localhost:${(appServer.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => { db.close(); appServer.close(); upstream.close(); });

async function post(body: unknown, token = 'tok-internal-1'): Promise<{ status: number; text: string; contentType: string }> {
  const res = await fetch(`${appUrl}/_llm/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') || '' };
}

describe('LLM proxy', () => {
  it('rejects requests without the internal token', async () => {
    const r = await post(ANTHROPIC_REQ, 'wrong-token');
    expect(r.status).toBe(401);
  });

  it('returns an anthropic-format error when no provider is active', async () => {
    const r = await post(ANTHROPIC_REQ);
    expect(r.status).toBe(500);
    const body = JSON.parse(r.text);
    expect(body.type).toBe('error');
    expect(body.error.message).toContain('供应商');
  });

  it('translates non-streaming OpenAI responses to Anthropic messages', async () => {
    repo.create({ name: 'DS', protocol: 'openai', baseUrl: upstreamUrl, apiKey: 'sk-up', model: 'deepseek-chat', isActive: false, source: 'manual' });
    const active = repo.list()[0];
    repo.activate(active.id);

    const r = await post(ANTHROPIC_REQ);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  it('translates streaming OpenAI SSE into Anthropic SSE events', async () => {
    const r = await post({ ...ANTHROPIC_REQ, stream: true });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('text/event-stream');
    expect(r.text).toContain('event: message_start');
    expect(r.text).toContain('"type":"text_delta","text":"你好"');
    expect(r.text).toContain('"type":"tool_use","id":"call_1","name":"Read"');
    expect(r.text).toContain('"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"');
    expect(r.text).toContain('"stop_reason":"tool_use"');
    expect(r.text).toContain('event: message_stop');
  });

  it('returns an error response instead of crashing on a malformed body', async () => {
    // messages 为非可迭代值会让 anthropicToOpenai 抛错：必须由 catch 兜底而非击穿进程
    const r = await post({ messages: 5 });
    expect([500, 502]).toContain(r.status);
    const body = JSON.parse(r.text);
    expect(body.type).toBe('error');
    // 进程必须存活：随后的正常请求仍成功
    const ok = await post(ANTHROPIC_REQ);
    expect(ok.status).toBe(200);
  });

  it('passes Anthropic-protocol requests through without modifying the body', async () => {
    repo.create({ name: '官方', protocol: 'anthropic', baseUrl: upstreamUrl, apiKey: 'sk-ant', model: 'claude-x', isActive: false, source: 'manual' });
    const target = repo.list().find(p => p.protocol === 'anthropic')!;
    repo.activate(target.id);

    const r = await post(ANTHROPIC_REQ);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.echo).toEqual(ANTHROPIC_REQ);   // 请求体原样到达上游
    expect(body.key).toBe('sk-ant');            // 鉴权头替换为供应商的
    expect(body.version).toBe('2023-06-01');
  });
});

describe('openaiChatUrl', () => {
  it('appends /v1/chat/completions for bare hosts', () => {
    expect(openaiChatUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('joins directly when the base already ends in /v<n>', () => {
    expect(openaiChatUrl('https://x.com/api/v1/')).toBe('https://x.com/api/v1/chat/completions');
  });

  it('does not double-append when the base already ends in /chat/completions', () => {
    expect(openaiChatUrl('https://x.com/open-api/develop/v1/develop-assistant/v1/chat/completions'))
      .toBe('https://x.com/open-api/develop/v1/develop-assistant/v1/chat/completions');
  });
});

describe('LLM proxy custom headers', () => {
  it('forwards provider custom headers to the OpenAI upstream', async () => {
    repo.create({
      name: '带头DS', protocol: 'openai', baseUrl: upstreamUrl, apiKey: 'sk-hdr',
      model: 'deepseek-chat', isActive: false, source: 'manual', headers: { Type: 'chat' },
    });
    const target = repo.list().find(p => p.name === '带头DS')!;
    repo.activate(target.id);

    const r = await post(ANTHROPIC_REQ);
    expect(r.status).toBe(200);
    expect(lastChatHeaders['type']).toBe('chat');
    expect(lastChatHeaders['authorization']).toBe('Bearer sk-hdr');
  });

  it('forwards provider custom headers on the Anthropic passthrough', async () => {
    repo.create({
      name: '带头官方', protocol: 'anthropic', baseUrl: upstreamUrl, apiKey: 'sk-ant2',
      model: 'claude-x', isActive: false, source: 'manual', headers: { Type: 'chat' },
    });
    const target = repo.list().find(p => p.name === '带头官方')!;
    repo.activate(target.id);

    const r = await post(ANTHROPIC_REQ);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.type).toBe('chat');
  });
});

describe('LLM proxy upstream timeouts', () => {
  async function setupProxy(baseUrl: string) {
    const db2 = await createMemoryDb();
    createTables(db2);
    const repo2 = new ProviderRepository(new DbHelper(db2));
    repo2.create({ name: 't', protocol: 'openai', baseUrl, apiKey: 'sk-t', model: 'm', isActive: true, source: 'manual' });
    const app2 = express();
    app2.use(express.json());
    app2.use('/_llm', createLlmProxy(repo2, 'tok', { connectTimeoutMs: 300, idleTimeoutMs: 300 }));
    const srv = app2.listen(0);
    return {
      url: `http://localhost:${(srv.address() as { port: number }).port}`,
      close: () => { srv.close(); db2.close(); },
    };
  }

  it('aborts with 502 when the upstream never sends response headers', async () => {
    const hangUp = http.createServer(() => { /* accept and never respond */ });
    await new Promise<void>(r => { hangUp.listen(0, () => r()); });
    const proxy = await setupProxy(`http://localhost:${(hangUp.address() as { port: number }).port}`);
    try {
      const started = Date.now();
      const res = await fetch(`${proxy.url}/_llm/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'tok' },
        body: JSON.stringify(ANTHROPIC_REQ),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain('超时');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      proxy.close();
      hangUp.close();
    }
  });

  it('ends the SSE stream when the upstream goes silent mid-response', async () => {
    const silent = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();   // 先把响应头发出去，随后静默
      // 之后不再发送任何数据，也不 end
    });
    await new Promise<void>(r => { silent.listen(0, () => r()); });
    const proxy = await setupProxy(`http://localhost:${(silent.address() as { port: number }).port}`);
    try {
      const started = Date.now();
      const res = await fetch(`${proxy.url}/_llm/v1/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'tok' },
        body: JSON.stringify({ ...ANTHROPIC_REQ, stream: true }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(text).toContain('event: message_stop');   // 截断也必须收尾
    } finally {
      proxy.close();
      silent.close();
    }
  });
});
