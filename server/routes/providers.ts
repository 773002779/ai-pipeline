import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProviderRepository } from '../db/repositories/providers';
import { parseContinueConfig } from '../llm/continue-import';
import { joinUrl, openaiChatUrl } from '../llm/proxy';
import type { LlmProvider } from '../../shared/types';

export function maskApiKey(key: string): string {
  return key ? `****${key.slice(-4)}` : '';
}

/** 自定义请求头入参清洗：非对象/数组视为未提供；键去空白；值统一转字符串 */
function sanitizeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!k.trim() || v == null) continue;
    out[k.trim()] = String(v);
  }
  return out;
}

function maskProvider(p: LlmProvider) {
  return { ...p, apiKey: maskApiKey(p.apiKey) };
}

export function createProviderRoutes(repo: ProviderRepository): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json({ success: true, data: repo.list().map(maskProvider) });
  });

  router.post('/', (req: Request, res: Response) => {
    const { name, protocol, baseUrl, apiKey, model, temperature, maxTokens, headers } = req.body || {};
    if (!name?.trim() || !['openai', 'anthropic'].includes(protocol) || !baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
      return res.status(400).json({ success: false, error: 'name, protocol(openai|anthropic), baseUrl, apiKey, model 均必填' });
    }
    const cleanedHeaders = sanitizeHeaders(headers);
    const created = repo.create({
      name: name.trim(), protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(),
      temperature: temperature ?? undefined, maxTokens: maxTokens ?? undefined,
      ...(cleanedHeaders && { headers: cleanedHeaders }),
      isActive: false, source: 'manual',
    });
    res.status(201).json({ success: true, data: maskProvider(created) });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const p = repo.getById(req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'Provider not found' });
    res.json({ success: true, data: maskProvider(p) });
  });

  router.put('/:id', (req: Request, res: Response) => {
    const existing = repo.getById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Provider not found' });
    const { name, protocol, baseUrl, apiKey, model, temperature, maxTokens, headers } = req.body || {};
    const updated = repo.update(req.params.id, {
      ...(name !== undefined && { name }),
      ...(protocol !== undefined && { protocol }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(apiKey?.trim() && { apiKey: apiKey.trim() }),   // 留空 = 不修改
      ...(model !== undefined && { model }),
      ...(temperature !== undefined && { temperature }),
      ...(maxTokens !== undefined && { maxTokens }),
      ...(headers !== undefined && { headers: sanitizeHeaders(headers) ?? {} }),   // 传空对象 = 清空
    });
    res.json({ success: true, data: updated ? maskProvider(updated) : null });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    if (!repo.delete(req.params.id)) return res.status(404).json({ success: false, error: 'Provider not found' });
    res.json({ success: true, data: { deleted: true } });
  });

  router.post('/:id/activate', (req: Request, res: Response) => {
    const activated = repo.activate(req.params.id);
    if (!activated) return res.status(404).json({ success: false, error: 'Provider not found' });
    res.json({ success: true, data: maskProvider(activated) });
  });

  router.post('/:id/test', async (req: Request, res: Response) => {
    const p = repo.getById(req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'Provider not found' });
    const started = Date.now();
    try {
      const resp = p.protocol === 'openai'
        ? await fetch(openaiChatUrl(p.baseUrl), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${p.apiKey}`,
              ...(p.headers ?? {}),
            },
            body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(10_000),
          })
        : await fetch(joinUrl(p.baseUrl, '/v1/messages'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': p.apiKey,
              'anthropic-version': '2023-06-01',
              ...(p.headers ?? {}),
            },
            body: JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
            signal: AbortSignal.timeout(10_000),
          });
      if (!resp.ok) {
        const text = await resp.text();
        return res.json({ success: true, data: { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` } });
      }
      res.json({ success: true, data: { ok: true, latencyMs: Date.now() - started } });
    } catch (err) {
      res.json({ success: true, data: { ok: false, error: (err as Error).message } });
    }
  });

  router.post('/import-continue', (req: Request, res: Response) => {
    const { configPath, content } = req.body || {};
    let yaml = content as string | undefined;
    if (!yaml) {
      const target = (configPath as string) || path.join(os.homedir(), '.continue', 'config.yaml');
      if (!fs.existsSync(target)) {
        return res.status(400).json({ success: false, error: `找不到 Continue 配置文件: ${target}` });
      }
      yaml = fs.readFileSync(target, 'utf-8');
    }
    const { providers, errors } = parseContinueConfig(yaml);
    const imported: LlmProvider[] = [];
    let skipped = 0;
    for (const p of providers) {
      const dup = repo.list().some(e => e.name === p.name && e.model === p.model);
      if (dup) { skipped++; continue; }
      imported.push(repo.create({ ...p, isActive: false, source: 'continue' }));
    }
    res.json({ success: true, data: { imported: imported.map(maskProvider), skipped, errors } });
  });

  return router;
}
