import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ProviderRepository } from '../db/repositories/providers';
import { createLlmProxy } from '../llm/proxy';
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase;
let repo: ProviderRepository;
let appServer: http.Server;
let upstream: http.Server;
let appUrl: string;
let upstreamUrl: string;

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
    res.json({ echo: req.body, key: req.headers['x-api-key'], version: req.headers['anthropic-version'] });
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
