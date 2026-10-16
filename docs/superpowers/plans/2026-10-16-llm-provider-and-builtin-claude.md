# 内置 Claude 与多供应商大模型接入 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 进程内 Anthropic↔OpenAI 协议转换代理 + 多供应商大模型配置（含 Continue 导入），使流水线开箱即用、不依赖本地 Claude 环境，并提供 start/stop/restart 运维脚本。

**Architecture:** Node 单进程内嵌 LLM 代理（挂载 `/_llm`，内部令牌防误调）；Agent SDK 通过环境变量把 `ANTHROPIC_BASE_URL` 指向本地代理；代理按当前生效供应商转发——Anthropic 协议透传、OpenAI 协议双向流式转换。设计文档：`docs/superpowers/specs/2026-10-16-llm-provider-and-builtin-claude-design.md`。

**Tech Stack:** TypeScript + Express 4 + sql.js + ws + React 18 + antd 5 + vitest；复用已有依赖（js-yaml、uuid），**不新增任何运行时依赖**。

## Global Constraints

- TDD：每个行为先写失败测试，看它失败，再写最小实现（测试代码在下方各步骤中给出）。
- 全程保持现有 81 个测试绿；每任务结束 `npx tsc --noEmit` 无错误。
- 单激活供应商：`providers` 表任意时刻最多一行 `is_active = 1`。
- 代理安全：`/_llm` 校验内部令牌（`x-api-key` 或 `Authorization: Bearer`），令牌进程启动时 `randomUUID()` 生成。
- API Key 存储：DB 明文；REST 返回一律脱敏（`****` + 后 4 位）。
- OpenAI 转换路径才应用供应商的 `temperature`/`max_tokens`；Anthropic 透传不改请求体。
- 生产模式判定：`NODE_ENV=production`（bat 设置）；开发模式行为不变。
- Windows 为主要目标平台；bat 用 `chcp 65001` + `%~dp0`。
- 测试命令：`npx vitest run <file>`（单文件）、`npm test`（全量）、`npx tsc --noEmit`（类型）。

---

### Task 1: Provider 数据层（类型 + 表 + 仓储）

**Files:**
- Modify: `shared/types.ts`（文件末尾追加类型）
- Modify: `server/db/schema.ts`（statements 数组追加一张表）
- Create: `server/db/repositories/providers.ts`
- Test: `server/__tests__/provider-repository.test.ts`

**Interfaces:**
- Consumes: `DbHelper`（`run/get/all`，已存在）
- Produces: `LlmProvider` 类型（shared）、`ProviderRepository`，方法签名：
  - `create(p: Omit<LlmProvider, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): LlmProvider`
  - `getById(id: string): LlmProvider | null`
  - `list(): LlmProvider[]`
  - `update(id: string, updates: Partial<Omit<LlmProvider, 'id' | 'createdAt'>>): LlmProvider | null`
  - `delete(id: string): boolean`
  - `activate(id: string): LlmProvider | null`
  - `getActive(): LlmProvider | null`

- [ ] **Step 1: 在 `shared/types.ts` 末尾追加类型**

```typescript
// ---- 大模型供应商 (LlmProvider) ----

export type LlmProtocol = 'openai' | 'anthropic';
export type ProviderSource = 'manual' | 'continue';

export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;          // 不含路径，如 https://api.deepseek.com
  apiKey: string;
  model: string;            // 默认模型名，如 deepseek-chat
  temperature?: number;
  maxTokens?: number;
  isActive: boolean;
  source: ProviderSource;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: 在 `server/db/schema.ts` 的 `statements` 数组末尾追加建表语句**

```typescript
    `CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL,
      max_tokens INTEGER,
      is_active INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'continue')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
```

- [ ] **Step 3: 写失败测试 `server/__tests__/provider-repository.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ProviderRepository } from '../db/repositories/providers';
import type { Database as SqlJsDatabase } from 'sql.js';
import type { LlmProvider } from '../../shared/types';

let db: SqlJsDatabase;
let repo: ProviderRepository;

function makeProvider(overrides: Partial<LlmProvider> = {}): Omit<LlmProvider, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'DeepSeek 官方',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test-1234567890',
    model: 'deepseek-chat',
    isActive: false,
    source: 'manual',
    ...overrides,
  };
}

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  repo = new ProviderRepository(new DbHelper(db));
});

afterAll(() => { db.close(); });

describe('ProviderRepository', () => {
  it('creates and gets a provider', () => {
    const p = repo.create(makeProvider());
    expect(p.id).toBeDefined();
    const got = repo.getById(p.id);
    expect(got?.name).toBe('DeepSeek 官方');
    expect(got?.protocol).toBe('openai');
    expect(got?.isActive).toBe(false);
  });

  it('lists providers with active first', () => {
    const a = repo.create(makeProvider({ name: 'A' }));
    const b = repo.create(makeProvider({ name: 'B' }));
    repo.activate(b.id);
    const names = repo.list().map(p => p.name);
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('A'));
    expect(a.id).toBeDefined();
  });

  it('update changes fields and keeps apiKey when omitted', () => {
    const p = repo.create(makeProvider({ name: 'Old' }));
    const updated = repo.update(p.id, { name: 'New' });
    expect(updated?.name).toBe('New');
    expect(updated?.apiKey).toBe('sk-test-1234567890');
  });

  it('delete removes the provider', () => {
    const p = repo.create(makeProvider());
    expect(repo.delete(p.id)).toBe(true);
    expect(repo.getById(p.id)).toBeNull();
  });

  it('activate is exclusive — only one provider is active', () => {
    const p1 = repo.create(makeProvider());
    const p2 = repo.create(makeProvider());
    repo.activate(p1.id);
    expect(repo.getActive()?.id).toBe(p1.id);
    repo.activate(p2.id);
    expect(repo.getActive()?.id).toBe(p2.id);
    expect(repo.getById(p1.id)?.isActive).toBe(false);
  });

  it('getActive returns null when nothing is active', () => {
    const fresh = new ProviderRepository(new DbHelper(db));
    // 本用例的库中已有激活项（上一用例激活了 p2）——先造一个干净的判断路径
    const p3 = fresh.create(makeProvider());
    fresh.activate(p3.id);
    expect(fresh.getActive()?.id).toBe(p3.id);
    // 直接关闭唯一激活项
    fresh.update(p3.id, { isActive: false });
    expect(fresh.getActive()).toBeNull();
  });

  it('rejects invalid protocol via CHECK constraint', () => {
    expect(() => repo.create(makeProvider({ protocol: 'grpc' as never }))).toThrow();
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npx vitest run server/__tests__/provider-repository.test.ts`
Expected: FAIL（`ProviderRepository` 模块不存在）

- [ ] **Step 5: 实现 `server/db/repositories/providers.ts`**

```typescript
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';
import type { LlmProvider } from '../../../shared/types';

export class ProviderRepository {
  constructor(private db: DbHelper) {}

  create(p: Omit<LlmProvider, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): LlmProvider {
    const id = p.id || uuidv4();
    const now = new Date().toISOString();
    const provider: LlmProvider = { ...p, id, createdAt: now, updatedAt: now };
    this.db.run(
      `INSERT INTO providers (id, name, protocol, base_url, api_key, model, temperature, max_tokens, is_active, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, provider.name, provider.protocol, provider.baseUrl, provider.apiKey, provider.model,
        provider.temperature ?? null, provider.maxTokens ?? null, provider.isActive ? 1 : 0,
        provider.source, now, now]
    );
    return provider;
  }

  getById(id: string): LlmProvider | null {
    return this.rowToProvider(
      this.db.get<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?', [id])
    );
  }

  list(): LlmProvider[] {
    return this.db.all<Record<string, unknown>>(
      'SELECT * FROM providers ORDER BY is_active DESC, updated_at DESC'
    ).map(r => this.rowToProvider(r)).filter((p): p is LlmProvider => p !== null);
  }

  update(id: string, updates: Partial<Omit<LlmProvider, 'id' | 'createdAt'>>): LlmProvider | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged: LlmProvider = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
    this.db.run(
      `UPDATE providers SET name=?, protocol=?, base_url=?, api_key=?, model=?, temperature=?, max_tokens=?, is_active=?, source=?, updated_at=? WHERE id=?`,
      [merged.name, merged.protocol, merged.baseUrl, merged.apiKey, merged.model,
        merged.temperature ?? null, merged.maxTokens ?? null, merged.isActive ? 1 : 0,
        merged.source, merged.updatedAt, id]
    );
    return merged;
  }

  delete(id: string): boolean {
    if (!this.getById(id)) return false;
    this.db.run('DELETE FROM providers WHERE id = ?', [id]);
    return true;
  }

  /** Exclusive activation: target on, everyone else off */
  activate(id: string): LlmProvider | null {
    if (!this.getById(id)) return null;
    this.db.run('UPDATE providers SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
    return this.getById(id);
  }

  getActive(): LlmProvider | null {
    return this.rowToProvider(
      this.db.get<Record<string, unknown>>('SELECT * FROM providers WHERE is_active = 1 LIMIT 1')
    );
  }

  private rowToProvider(row: Record<string, unknown> | undefined): LlmProvider | null {
    if (!row) return null;
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      protocol: row['protocol'] as LlmProvider['protocol'],
      baseUrl: row['base_url'] as string,
      apiKey: row['api_key'] as string,
      model: row['model'] as string,
      temperature: (row['temperature'] as number) ?? undefined,
      maxTokens: (row['max_tokens'] as number) ?? undefined,
      isActive: row['is_active'] === 1,
      source: row['source'] as LlmProvider['source'],
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }
}
```

- [ ] **Step 6: 运行测试确认通过 + 类型检查**

Run: `npx vitest run server/__tests__/provider-repository.test.ts && npx tsc --noEmit`
Expected: 7 tests PASS，tsc 无错误

- [ ] **Step 7: 提交**

```bash
git add shared/types.ts server/db/schema.ts server/db/repositories/providers.ts server/__tests__/provider-repository.test.ts
git commit -m "feat: providers 数据层（表 + 仓储 + 单激活）"
```

---

### Task 2: Continue 配置解析器

**Files:**
- Create: `server/llm/continue-import.ts`
- Test: `server/__tests__/continue-import.test.ts`

**Interfaces:**
- Consumes: `js-yaml`（已有依赖）
- Produces: `parseContinueConfig(content: string): { providers: ContinueProviderImport[]; errors: string[] }`；`ContinueProviderImport = { name: string; protocol: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; model: string }`

- [ ] **Step 1: 写失败测试 `server/__tests__/continue-import.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseContinueConfig } from '../llm/continue-import';

describe('parseContinueConfig', () => {
  it('parses models with explicit apiBase', () => {
    const yaml = `
name: My Config
models:
  - name: DeepSeek
    provider: deepseek
    model: deepseek-chat
    apiKey: sk-abc
    apiBase: https://api.deepseek.com
    roles: [chat, edit]
`;
    const { providers, errors } = parseContinueConfig(yaml);
    expect(errors).toEqual([]);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual({
      name: 'DeepSeek', protocol: 'openai',
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-abc', model: 'deepseek-chat',
    });
  });

  it('infers protocol from provider name (anthropic → anthropic)', () => {
    const yaml = `
models:
  - name: Claude
    provider: anthropic
    model: claude-sonnet-4
    apiKey: sk-ant
`;
    const { providers } = parseContinueConfig(yaml);
    expect(providers[0].protocol).toBe('anthropic');
    expect(providers[0].baseUrl).toBe('https://api.anthropic.com');
  });

  it('falls back to provider-specific default base URLs', () => {
    const yaml = `
models:
  - name: DS
    provider: deepseek
    model: deepseek-reasoner
`;
    const { providers } = parseContinueConfig(yaml);
    expect(providers[0].baseUrl).toBe('https://api.deepseek.com');
    expect(providers[0].apiKey).toBe('');
  });

  it('skips non-chat roles and entries without model', () => {
    const yaml = `
models:
  - name: Embed
    provider: openai
    model: text-embedding-3-small
    roles: [embed]
  - name: NoModel
    provider: openai
`;
    const { providers, errors } = parseContinueConfig(yaml);
    expect(providers).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('NoModel');
  });

  it('returns an error for invalid yaml or missing models array', () => {
    expect(parseContinueConfig(':::bad yaml:::').errors.length).toBe(1);
    expect(parseContinueConfig('name: x').errors[0]).toContain('models');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/continue-import.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/llm/continue-import.ts`**

```typescript
/**
 * Parse Continue.dev config.yaml and map its models[] to provider imports.
 * Protocol inference: provider containing "anthropic" → anthropic, else openai.
 * Only entries with a chat role (or no roles field) are imported.
 */
import yaml from 'js-yaml';

export interface ContinueProviderImport {
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

interface ContinueModelEntry {
  name?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  apiBase?: string;
  roles?: string[];
}

export function parseContinueConfig(content: string): { providers: ContinueProviderImport[]; errors: string[] } {
  let doc: { models?: ContinueModelEntry[] } | null = null;
  try {
    doc = yaml.load(content) as { models?: ContinueModelEntry[] } | null;
  } catch (err) {
    return { providers: [], errors: [`YAML 解析失败: ${(err as Error).message}`] };
  }
  if (!doc || !Array.isArray(doc.models)) {
    return { providers: [], errors: ['配置中没有 models 数组'] };
  }

  const providers: ContinueProviderImport[] = [];
  const errors: string[] = [];
  doc.models.forEach((m, i) => {
    if (!m?.model) {
      errors.push(`models[${i}] "${m?.name ?? '未命名'}": 缺少 model 字段，跳过`);
      return;
    }
    if (Array.isArray(m.roles) && !m.roles.includes('chat')) {
      return; // 非对话角色（embed/autocomplete 等）不导入
    }
    const providerKey = (m.provider || 'openai').toLowerCase();
    providers.push({
      name: m.name || `${m.provider || 'openai'}/${m.model}`,
      protocol: providerKey.includes('anthropic') ? 'anthropic' : 'openai',
      baseUrl: m.apiBase || DEFAULT_BASE[providerKey] || DEFAULT_BASE.openai,
      apiKey: m.apiKey || '',
      model: m.model,
    });
  });
  return { providers, errors };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/__tests__/continue-import.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: 提交**

```bash
git add server/llm/continue-import.ts server/__tests__/continue-import.test.ts
git commit -m "feat: Continue.dev config.yaml 解析器"
```

---

### Task 3: Providers REST 路由（CRUD / 激活 / 测试 / 导入）

**Files:**
- Create: `server/routes/providers.ts`
- Modify: `server/app.ts`（挂载路由）
- Test: `server/__tests__/provider-routes.test.ts`

**Interfaces:**
- Consumes: `ProviderRepository`（Task 1）、`parseContinueConfig`（Task 2）、`DbHelper`
- Produces: Router 挂载于 `/api/providers`：
  - `GET /` → `LlmProvider[]`（apiKey 脱敏为 `****后4位`）
  - `POST /` body `{name, protocol, baseUrl, apiKey, model, temperature?, maxTokens?}` → 201
  - `PUT /:id`（apiKey 留空/缺省 = 不修改）
  - `DELETE /:id`
  - `POST /:id/activate`
  - `POST /:id/test` → `{ok, latencyMs?, error?}`（10s 超时）
  - `POST /import-continue` body `{configPath?, content?}` → `{imported: LlmProvider[], skipped: number, errors: string[]}`

- [ ] **Step 1: 写失败测试 `server/__tests__/provider-routes.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { ProviderRepository } from '../db/repositories/providers';
import { createProviderRoutes } from '../routes/providers';
import type { Database as SqlJsDatabase } from 'sql.js';

let db: SqlJsDatabase;
let server: http.Server;
let upstream: http.Server;
let baseUrl: string;
let upstreamUrl: string;
let repo: ProviderRepository;
let continueYamlPath: string;

beforeAll(async () => {
  db = await createMemoryDb();
  createTables(db);
  repo = new ProviderRepository(new DbHelper(db));

  // Mock OpenAI-protocol upstream for the /test endpoint
  const up = express();
  up.use(express.json());
  up.post('/v1/chat/completions', (_req, res) => {
    res.json({ id: 'cmpl-1', choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  await new Promise<void>(r => { upstream = up.listen(0, () => r()); });
  upstreamUrl = `http://localhost:${(upstream.address() as { port: number }).port}`;

  // A Continue config.yaml on disk for import test
  continueYamlPath = path.join(os.tmpdir(), `continue-config-${Date.now()}.yaml`);
  fs.writeFileSync(continueYamlPath, `
models:
  - name: 导入的DS
    provider: deepseek
    model: deepseek-chat
    apiKey: sk-imp
    apiBase: ${upstreamUrl}
`, 'utf-8');

  const app = express();
  app.use(express.json());
  app.use('/api/providers', createProviderRoutes(repo));
  await new Promise<void>(r => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => {
  db.close(); server.close(); upstream.close();
  fs.rmSync(continueYamlPath, { force: true });
});

async function createProvider(body: Record<string, unknown>): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${baseUrl}/api/providers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'openai', model: 'gpt-test', apiKey: 'sk-secret-9999', ...body }),
  });
  expect(res.status).toBe(201);
  const { data } = await res.json();
  return data;
}

describe('Provider routes', () => {
  it('creates, lists with masked key, gets 400 on invalid', async () => {
    const created = await createProvider({ name: '测试DS', baseUrl: upstreamUrl });
    expect(created.apiKey).toBe('****9999');

    const list = await (await fetch(`${baseUrl}/api/providers`)).json();
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    expect(list.data[0].apiKey).toMatch(/^\*\*/);

    const bad = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', protocol: 'grpc', baseUrl: 'http://x', apiKey: 'k', model: 'm' }),
    });
    expect(bad.status).toBe(400);
  });

  it('update keeps apiKey when omitted, replaces when provided', async () => {
    const p = await createProvider({ name: '改Key', baseUrl: upstreamUrl });
    const res1 = await fetch(`${baseUrl}/api/providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '改Key2' }),
    });
    const { data: d1 } = await res1.json();
    expect(d1.name).toBe('改Key2');
    expect(d1.apiKey).toBe('****9999'); // 未提供 → 保留

    await fetch(`${baseUrl}/api/providers/${p.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-new-0001' }),
    });
    const got = await (await fetch(`${baseUrl}/api/providers/${p.id}`)).json();
    expect(got.data.apiKey).toBe('****0001');
  });

  it('activate switches exclusive active provider', async () => {
    const a = await createProvider({ name: 'A', baseUrl: upstreamUrl });
    const b = await createProvider({ name: 'B', baseUrl: upstreamUrl });
    await fetch(`${baseUrl}/api/providers/${a.id}/activate`, { method: 'POST' });
    await fetch(`${baseUrl}/api/providers/${b.id}/activate`, { method: 'POST' });
    const list = (await (await fetch(`${baseUrl}/api/providers`)).json()).data;
    const active = list.filter((p: { isActive: boolean }) => p.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(b.id);
  });

  it('test endpoint returns ok with latency against mock upstream', async () => {
    const p = await createProvider({ name: '连通', baseUrl: upstreamUrl });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}/test`, { method: 'POST' });
    const { data } = await res.json();
    expect(data.ok).toBe(true);
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('test endpoint reports unreachable upstream', async () => {
    const p = await createProvider({ name: '不通', baseUrl: 'http://localhost:1' });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}/test`, { method: 'POST' });
    const { data } = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();
  });

  it('imports providers from a Continue config.yaml path', async () => {
    const res = await fetch(`${baseUrl}/api/providers/import-continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configPath: continueYamlPath }),
    });
    const { data } = await res.json();
    expect(data.imported).toHaveLength(1);
    expect(data.imported[0].name).toBe('导入的DS');
    expect(data.imported[0].source).toBe('continue');

    // 再导入一次 → 按 name+model 去重跳过
    const res2 = await fetch(`${baseUrl}/api/providers/import-continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configPath: continueYamlPath }),
    });
    const { data: d2 } = await res2.json();
    expect(d2.imported).toHaveLength(0);
    expect(d2.skipped).toBe(1);
  });

  it('deletes a provider', async () => {
    const p = await createProvider({ name: '删我', baseUrl: upstreamUrl });
    const res = await fetch(`${baseUrl}/api/providers/${p.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const got = await fetch(`${baseUrl}/api/providers/${p.id}`);
    expect(got.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/provider-routes.test.ts`
Expected: FAIL（`createProviderRoutes` 不存在）

- [ ] **Step 3: 实现 `server/routes/providers.ts`**

```typescript
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProviderRepository } from '../db/repositories/providers';
import { parseContinueConfig } from '../llm/continue-import';
import type { LlmProvider } from '../../shared/types';

export function maskApiKey(key: string): string {
  return key ? `****${key.slice(-4)}` : '';
}

function joinUrl(base: string, pathSuffix: string): string {
  return `${base.replace(/\/+$/, '')}${pathSuffix}`;
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
    const { name, protocol, baseUrl, apiKey, model, temperature, maxTokens } = req.body || {};
    if (!name?.trim() || !['openai', 'anthropic'].includes(protocol) || !baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
      return res.status(400).json({ success: false, error: 'name, protocol(openai|anthropic), baseUrl, apiKey, model 均必填' });
    }
    const created = repo.create({
      name: name.trim(), protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim(),
      temperature: temperature ?? undefined, maxTokens: maxTokens ?? undefined,
      isActive: false, source: 'manual',
    });
    res.status(201).json({ success: true, data: maskProvider(created) });
  });

  router.put('/:id', (req: Request, res: Response) => {
    const existing = repo.getById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Provider not found' });
    const { name, protocol, baseUrl, apiKey, model, temperature, maxTokens } = req.body || {};
    const updated = repo.update(req.params.id, {
      ...(name !== undefined && { name }),
      ...(protocol !== undefined && { protocol }),
      ...(baseUrl !== undefined && { baseUrl }),
      ...(apiKey?.trim() && { apiKey: apiKey.trim() }),   // 留空 = 不修改
      ...(model !== undefined && { model }),
      ...(temperature !== undefined && { temperature }),
      ...(maxTokens !== undefined && { maxTokens }),
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
        ? await fetch(joinUrl(p.baseUrl, '/chat/completions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
            body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(10_000),
          })
        : await fetch(joinUrl(p.baseUrl, '/v1/messages'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
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
```

- [ ] **Step 4: 挂载到 `server/app.ts`**

在 imports 区追加：

```typescript
import { createProviderRoutes } from './routes/providers';
import { ProviderRepository } from './db/repositories/providers';
```

在 `if (options.dbHelper) {` 块内（`stepRepo` 创建之后）追加：

```typescript
    const providerRepo = new ProviderRepository(options.dbHelper);
    app.use('/api/providers', createProviderRoutes(providerRepo));
```

- [ ] **Step 5: 运行确认通过 + 类型检查**

Run: `npx vitest run server/__tests__/provider-routes.test.ts && npx tsc --noEmit`
Expected: 7 tests PASS，tsc 无错误

- [ ] **Step 6: 提交**

```bash
git add server/routes/providers.ts server/app.ts server/__tests__/provider-routes.test.ts
git commit -m "feat: providers REST（CRUD/激活/连通测试/Continue 导入）"
```

---

### Task 4: 请求转换（Anthropic → OpenAI，纯函数）

**Files:**
- Create: `server/llm/translate-request.ts`
- Test: `server/__tests__/translate-request.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `anthropicToOpenai(req: AnthropicMessagesRequest, overrides?: { temperature?: number; maxTokens?: number }): OpenAiChatRequest`
  - 类型 `AnthropicMessagesRequest`、`AnthropicMessage`、`AnthropicContentBlock`、`OpenAiChatRequest`、`OpenAiMessage`（Task 6 依赖这些确切名字）

- [ ] **Step 1: 写失败测试 `server/__tests__/translate-request.test.ts`**

```typescript
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/translate-request.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/llm/translate-request.ts`**

```typescript
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/__tests__/translate-request.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: 提交**

```bash
git add server/llm/translate-request.ts server/__tests__/translate-request.test.ts
git commit -m "feat: Anthropic→OpenAI 请求转换（纯函数）"
```

---

### Task 5: 流式响应转换（OpenAI SSE → Anthropic SSE 状态机）

**Files:**
- Create: `server/llm/translate-stream.ts`
- Test: `server/__tests__/translate-stream.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class StreamTranslator`：`process(chunk: OpenAiStreamChunk): Generator<AnthropicSseEvent>`、`finish(): Generator<AnthropicSseEvent>`（幂等，可重复调用）
  - `OpenAiStreamChunk`、`AnthropicSseEvent = { event: string; data: Record<string, unknown> }`、`STOP_REASON: Record<string, string>`（Task 6 依赖）

- [ ] **Step 1: 写失败测试 `server/__tests__/translate-stream.test.ts`**

```typescript
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
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"comm' } }] } } }] } as OpenAiStreamChunk,
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } } }] as unknown as OpenAiStreamChunk,
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
      ] } } }] as OpenAiStreamChunk,
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/translate-stream.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/llm/translate-stream.ts`**

```typescript
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
      yield* this.finish();
    }
  }

  /** Close out the message. Idempotent; safe to call multiple times. */
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/__tests__/translate-stream.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: 提交**

```bash
git add server/llm/translate-stream.ts server/__tests__/translate-stream.test.ts
git commit -m "feat: OpenAI SSE→Anthropic SSE 流式转换状态机"
```

---

### Task 6: LLM 代理（/_llm 挂载 + 内部令牌 + 双协议转发）

**Files:**
- Create: `server/llm/internal-token.ts`
- Create: `server/llm/proxy.ts`
- Modify: `server/app.ts`（AppOptions 增加 `llmProxy?: Router` 并挂载）
- Test: `server/__tests__/llm-proxy.test.ts`

**Interfaces:**
- Consumes: `ProviderRepository.getActive()`（Task 1）、`anthropicToOpenai`（Task 4）、`StreamTranslator`/`STOP_REASON`（Task 5）
- Produces:
  - `setInternalToken(t: string): void` / `getInternalToken(): string | null`（Task 7 的 agent-manager 依赖）
  - `createLlmProxy(repo: ProviderRepository, internalToken: string): Router`（POST `/_llm/v1/messages`）
  - `joinUrl(base: string, path: string): string`（Task 3 的路由也可用它，但 Task 3 已自带私有实现，不强制回改）

- [ ] **Step 1: 创建 `server/llm/internal-token.ts`（无需测试，纯存取）**

```typescript
/** Process-wide internal token guarding the /_llm proxy endpoint. */
let token: string | null = null;

export function setInternalToken(t: string): void {
  token = t;
}

export function getInternalToken(): string | null {
  return token;
}
```

- [ ] **Step 2: 写失败测试 `server/__tests__/llm-proxy.test.ts`**

```typescript
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
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run server/__tests__/llm-proxy.test.ts`
Expected: FAIL（`createLlmProxy` 不存在）

- [ ] **Step 4: 实现 `server/llm/proxy.ts`**

```typescript
/**
 * In-process LLM proxy: exposes an Anthropic-Messages-compatible endpoint at
 * /_llm/v1/messages and forwards to the active provider — translating for
 * OpenAI-protocol providers, passing through for Anthropic-protocol ones.
 */
import { Router, Request, Response } from 'express';
import { ProviderRepository } from '../db/repositories/providers';
import { anthropicToOpenai, type AnthropicMessagesRequest } from './translate-request';
import { StreamTranslator, STOP_REASON, type OpenAiStreamChunk } from './translate-stream';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function errorBody(message: string): Record<string, unknown> {
  return { type: 'error', error: { type: 'api_error', message } };
}

function writeSse(res: Response, ev: { event: string; data: Record<string, unknown> }): void {
  res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
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
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (err) {
        if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${(err as Error).message}`));
        else res.end();
      }
      return;
    }

    // ---- OpenAI 协议：转换 ----
    const body = anthropicToOpenai(req.body as AnthropicMessagesRequest, {
      temperature: provider.temperature ?? undefined,
      maxTokens: provider.maxTokens ?? undefined,
    });
    try {
      const upstream = await fetch(joinUrl(provider.baseUrl, '/chat/completions'), {
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
        await consumeSse(
          upstream.body,
          chunk => { for (const ev of translator.process(chunk)) writeSse(res, ev); },
          () => { for (const ev of translator.finish()) writeSse(res, ev); },
        );
        res.end();
      } else {
        const json = await upstream.json() as Record<string, any>;
        res.status(200).json(openaiJsonToAnthropic(json, (req.body as AnthropicMessagesRequest).model || ''));
      }
    } catch (err) {
      if (!res.headersSent) res.status(502).json(errorBody(`上游请求失败: ${(err as Error).message}`));
      else res.end();
    }
  });

  return router;
}
```

- [ ] **Step 5: 创建 `server/startup-checks.ts` 并在 `server/app.ts` 挂载**

（`startup-checks.ts` 在本任务创建；`server/index.ts` 的接线在 Task 8。）

`AppOptions` 增加字段：

```typescript
export interface AppOptions {
  dbHelper?: DbHelper;
  wsChannel?: SessionChannel;
  llmProxy?: Router;          // /_llm 协议转换代理（index.ts 组装后传入）
  checks?: StartupChecks;     // 启动自检结果（Task 8 填充，本任务先留可选）
  staticDir?: string;         // 生产模式静态目录（Task 8 使用）
}
```

`app.ts` imports 追加：

```typescript
import type { Router } from 'express';
import type { StartupChecks } from './startup-checks';
```

创建 `server/startup-checks.ts`：

```typescript
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface StartupChecks {
  cliBundled: boolean;
  gitBashPath?: string;
  gitBashStatus: 'ok' | 'missing' | 'not-windows';
  hasActiveProvider: boolean;
}

const GIT_BASH_CANDIDATES = [
  'D:\\develop\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
];

export function runStartupChecks(opts: { hasActiveProvider: boolean }): StartupChecks {
  const cliPath = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  const cliBundled = fs.existsSync(cliPath);

  let gitBashStatus: StartupChecks['gitBashStatus'] = 'not-windows';
  let gitBashPath: string | undefined;
  if (process.platform === 'win32') {
    const fromEnv = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (fromEnv && fs.existsSync(fromEnv)) {
      gitBashPath = fromEnv;
      gitBashStatus = 'ok';
    } else {
      gitBashStatus = 'missing';
      for (const c of GIT_BASH_CANDIDATES) {
        if (fs.existsSync(c)) { gitBashPath = c; gitBashStatus = 'ok'; break; }
      }
      if (gitBashStatus === 'missing') {
        try { execSync('where bash', { stdio: 'ignore' }); gitBashStatus = 'ok'; } catch { /* 保持 missing */ }
      }
    }
  }
  return { cliBundled, gitBashPath, gitBashStatus, hasActiveProvider: opts.hasActiveProvider };
}
```

`app.ts` 的 `if (options.dbHelper) {` 块内，providers 路由之后追加（`llmProxy` 与 `checks` 都可选，测试不传也不炸）：

```typescript
    if (options.llmProxy) app.use('/_llm', options.llmProxy);
```

health 端点替换为：

```typescript
  app.get('/api/health', (_req, res) => {
    res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString(), checks: options.checks ?? null } });
  });
```

- [ ] **Step 6: 运行确认通过 + 全量回归**

Run: `npx vitest run server/__tests__/llm-proxy.test.ts server/__tests__/api-health.test.ts && npx tsc --noEmit`
Expected: llm-proxy 5 tests PASS；api-health 若因新增 `checks` 字段断言失败（exact shape 断言），把断言改为 `toHaveProperty('status', 'ok')` 形式后通过；tsc 无错误

- [ ] **Step 7: 提交**

```bash
git add server/llm/proxy.ts server/llm/internal-token.ts server/startup-checks.ts server/app.ts server/__tests__/llm-proxy.test.ts
git commit -m "feat: /_llm 进程内协议转换代理 + 内部令牌 + 启动自检模块"
```

---

### Task 7: SDK 环境注入 + 无供应商 400 + defaultModel 链路

**Files:**
- Modify: `server/claude/agent-manager.ts`（buildSdkOptions 注入 env；AgentCallConfig 增加 defaultModel）
- Modify: `server/engine/executor.ts`（execute 增加第 4 参数 options）
- Modify: `server/routes/sessions.ts`（deps 增加 providerRepo；start/resume 前置校验；launchExecutor 传 defaultModel）
- Test: `server/__tests__/agent-manager.test.ts`（追加）、`server/__tests__/session-routes.test.ts`（追加）

**Interfaces:**
- Consumes: `getInternalToken()`（Task 6）、`config.port`、`ProviderRepository.getActive()`（Task 1）
- Produces:
  - `AgentCallConfig` 增加 `defaultModel?: string`
  - `PipelineExecutor.execute(session, wsChannel, outputDir, options?: { defaultModel?: string })`

- [ ] **Step 1: 在 `server/__tests__/agent-manager.test.ts` 追加失败测试**

文件顶部 import 区追加：

```typescript
import { setInternalToken } from '../llm/internal-token';
```

describe 块追加：

```typescript
describe('ClaudeAgentManager SDK env injection', () => {
  it('routes the SDK through the in-process proxy and isolates config dir', () => {
    setInternalToken('tok-test-1');
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig());
    const env = options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toContain('/_llm');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok-test-1');
    expect(env.CLAUDE_CONFIG_DIR).toContain('.pipeline');
    expect(env.CLAUDE_CONFIG_DIR).toContain('claude-config');
  });

  it('falls back to defaultModel when template/agent do not pin a model', () => {
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig({ defaultModel: 'deepseek-chat' }));
    expect(options.model).toBe('deepseek-chat');
  });
});
```

- [ ] **Step 2: 在 `server/__tests__/session-routes.test.ts` 追加失败测试**

setup 区追加（`stepRepo` 创建之后）：

```typescript
import { ProviderRepository } from '../db/repositories/providers';

let providerRepo: ProviderRepository;
let appWithProviders: http.Server;
let providerApiBase: string;   // 指向带 providerRepo 的第二个路由实例
```

beforeAll 内、第一个 app 启动之后追加：

```typescript
  providerRepo = new ProviderRepository(dbHelper);

  const app2 = express();
  app2.use(express.json());
  app2.use('/api/sessions', createSessionRoutes(dbHelper, {
    wsChannel,
    resourceRepo,
    stepRepo,
    providerRepo,
    executorFactory: (session) => { executorFactoryCalls.push(session); return neverEnding(); },
  }));
  await new Promise<void>((resolve) => {
    appWithProviders = app2.listen(0, () => {
      providerApiBase = `http://localhost:${(appWithProviders.address() as { port: number }).port}`;
      resolve();
    });
  });
```

describe 追加：

```typescript
describe('Session start requires an active provider', () => {
  it('rejects start/resume with 400 when no provider is active', async () => {
    const id = await createSession('无供应商');
    // 走带 providerRepo 的实例；此时无激活供应商
    const res = await fetch(`${providerApiBase}/api/sessions/${id}/start`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('供应商');

    const res2 = await fetch(`${providerApiBase}/api/sessions/${id}/resume`, { method: 'POST' });
    expect(res2.status).toBe(400);
  });

  it('allows start once a provider is active', async () => {
    const p = providerRepo.create({
      name: 'DS', protocol: 'openai', baseUrl: 'http://localhost:9', apiKey: 'sk-x',
      model: 'deepseek-chat', isActive: false, source: 'manual',
    });
    providerRepo.activate(p.id);
    const id = await createSession('有供应商');
    const res = await fetch(`${providerApiBase}/api/sessions/${id}/start`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run server/__tests__/agent-manager.test.ts server/__tests__/session-routes.test.ts`
Expected: 新增 3 个用例 FAIL（env 未注入 / defaultModel 不存在 / start 未返回 400）

- [ ] **Step 4: 修改 `server/claude/agent-manager.ts`**

imports 追加：

```typescript
import path from 'path';
import { config } from '../config';
import { getInternalToken } from '../llm/internal-token';
```

`AgentCallConfig` 追加字段（`wsChannel` 之前）：

```typescript
  defaultModel?: string;   // 当前生效供应商的默认模型名（路由层传入）
```

`buildSdkOptions` 内做两处修改：

(a) 模型解析链去掉 `process.env.ANTHROPIC_MODEL`、加入 `config.defaultModel`：

```typescript
    // Resolve model: template override → agent config → active provider default
    const resolvedModel =
      config.template.model ||
      (config.resolvedAgent?.config as { model?: string })?.model ||
      config.defaultModel ||
      undefined; // 都没有则交给 CLI 默认
```

(b) env 块（git-bash 检测之后）追加三行：

```typescript
    // SDK 请求统一走进程内协议转换代理；配置目录隔离本机 ~/.claude
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${config.port}/_llm`;
    env.ANTHROPIC_AUTH_TOKEN = getInternalToken() || 'missing-internal-token';
    env.CLAUDE_CONFIG_DIR = path.join(process.cwd(), '.pipeline', 'claude-config');
```

- [ ] **Step 5: 修改 `server/engine/executor.ts`**

`execute` 签名改为：

```typescript
  async *execute(
    session: Session,
    wsChannel: SessionChannel,
    outputDir: string,
    options?: { defaultModel?: string },
  ): AsyncGenerator<AgentEvent> {
```

`this.agentManager.execute({...})` 的配置对象追加一行：

```typescript
          defaultModel: options?.defaultModel,
```

- [ ] **Step 6: 修改 `server/routes/sessions.ts`**

deps 增加：

```typescript
export interface SessionRouteDeps {
  wsChannel?: SessionChannel;
  resourceRepo: ResourceRepository;
  stepRepo: StepRepository;
  providerRepo?: ProviderRepository;
  executorFactory?: (session: Session) => AsyncGenerator<unknown>;
}
```

import 追加 `import { ProviderRepository } from '../db/repositories/providers';`

新增守卫函数（`launchExecutor` 之前）：

```typescript
  /** 需要已激活供应商的路由守卫：未配置时返回 400 */
  function requireActiveProvider(res: Response): boolean {
    if (deps?.providerRepo && !deps.providerRepo.getActive()) {
      res.status(400).json({ success: false, error: '未配置生效的大模型供应商，请在「模型配置」页激活' });
      return false;
    }
    return true;
  }
```

`start` 路由 409 检查之后、`updateStatus` 之前插入：

```typescript
      if (!requireActiveProvider(res)) return;
```

`resume` 路由 `sessionRepo.getById` 判空之后插入同一行。

`launchExecutor` 中真实执行器分支替换为：

```typescript
    const gen = deps.executorFactory
      ? deps.executorFactory(session)
      : new PipelineExecutor(sessionRepo, deps.resourceRepo, deps.stepRepo)
          .execute(session, deps.wsChannel, config.outputDir, {
            defaultModel: deps.providerRepo?.getActive()?.model,
          });
```

- [ ] **Step 7: 运行确认通过 + 全量回归**

Run: `npm test && npx tsc --noEmit`
Expected: 全部 PASS（含既有 81 个），tsc 无错误

- [ ] **Step 8: 提交**

```bash
git add server/claude/agent-manager.ts server/engine/executor.ts server/routes/sessions.ts server/__tests__/agent-manager.test.ts server/__tests__/session-routes.test.ts
git commit -m "feat: SDK 走进程内代理 + 无供应商 400 + defaultModel 解析链"
```

---

### Task 8: 启动接线（令牌/自检/隔离目录/静态托管）

**Files:**
- Modify: `server/index.ts`
- Modify: `server/app.ts`（staticDir 挂载）
- Test: `server/__tests__/static-serving.test.ts`

**Interfaces:**
- Consumes: `runStartupChecks`（Task 6 已建文件）、`setInternalToken`、`createLlmProxy`（Task 6）、`ProviderRepository`
- Produces: 生产模式（`NODE_ENV=production`）下 3001 端口直接提供前端页面；`/api/health` 返回 `checks`

- [ ] **Step 1: 写失败测试 `server/__tests__/static-serving.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createApp } from '../app';
import type { Database as SqlJsDatabase } from 'sql.js';

let server: http.Server;
let baseUrl: string;
let staticDir: string;

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);

  staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html><body>AI Pipeline SPA</body></html>', 'utf-8');

  const app = createApp({
    dbHelper: new DbHelper(db),
    staticDir,
  });
  await new Promise<void>(r => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
      r();
    });
  });
});

afterAll(() => {
  server.close();
  fs.rmSync(staticDir, { recursive: true, force: true });
});

describe('static SPA serving (production mode)', () => {
  it('serves index.html at root', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AI Pipeline SPA');
  });

  it('falls back to index.html for SPA routes', async () => {
    const res = await fetch(`${baseUrl}/sessions/abc-123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('AI Pipeline SPA');
  });

  it('does not swallow /api 404s', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/static-serving.test.ts`
Expected: FAIL（createApp 尚不支持 staticDir / 返回 404 JSON）

- [ ] **Step 3: 在 `server/app.ts` 实现静态托管**

imports 追加：

```typescript
import fs from 'fs';
import path from 'path';
```

404 handler 之前插入：

```typescript
  // 生产模式：托管前端构建产物 + SPA fallback
  if (options.staticDir && fs.existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/_llm') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }
```

- [ ] **Step 4: 修改 `server/index.ts` 接线**

imports 追加（`fs` 与 `path` 当前均未导入，需一并加）：

```typescript
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ProviderRepository } from './db/repositories/providers';
import { createLlmProxy } from './llm/proxy';
import { setInternalToken } from './llm/internal-token';
import { runStartupChecks, type StartupChecks } from './startup-checks';
```

在 stepLoader 加载之后、创建 HTTP server 之前插入：

```typescript
  // LLM 代理：内部令牌 + 自检 + 隔离的 Claude 配置目录
  const internalToken = randomUUID();
  setInternalToken(internalToken);
  const providerRepo = new ProviderRepository(dbHelper);
  const checks: StartupChecks = runStartupChecks({ hasActiveProvider: !!providerRepo.getActive() });
  if (checks.gitBashPath) {
    process.env.CLAUDE_CODE_GIT_BASH_PATH = checks.gitBashPath;
  }
  fs.mkdirSync(path.join(process.cwd(), '.pipeline', 'claude-config'), { recursive: true });
```

`createApp(...)` 调用替换为：

```typescript
  const app = createApp({
    dbHelper,
    wsChannel,
    llmProxy: createLlmProxy(providerRepo, internalToken),
    staticDir: process.env.NODE_ENV === 'production' ? path.join(process.cwd(), 'dist') : undefined,
    checks,
  });
```

启动横幅（`server.listen` 回调）中 `║  WS:      ...` 行之前插入三行（对齐现有框线宽度）：

```typescript
    console.log(`  ║  LLM代理: /_llm (内置令牌)  CLI: ${checks.cliBundled ? '已内置' : '缺失!'}          ║`);
    console.log(`  ║  GitBash: ${checks.gitBashStatus === 'ok' ? '已定位' : checks.gitBashStatus}   生效模型: ${checks.hasActiveProvider ? '已配置' : '未配置!'}  ║`);
    console.log(`  ║  Claude配置目录: .pipeline/claude-config (已隔离)        ║`);
```

（横幅为纯打印，宽度不严格对齐不影响功能。）

- [ ] **Step 5: 运行确认通过 + 全量回归**

Run: `npm test && npx tsc --noEmit`
Expected: 全部 PASS（api-health 若对 `checks: null` 断言冲突，保持 `toHaveProperty` 宽松断言），tsc 无错误

- [ ] **Step 6: 提交**

```bash
git add server/index.ts server/app.ts server/__tests__/static-serving.test.ts
git commit -m "feat: 生产模式静态托管 + 启动自检接线 + 隔离配置目录"
```

---

### Task 9: 前端「模型配置」页

**Files:**
- Modify: `src/types/index.ts`（re-export 追加）
- Create: `src/api/providers.ts`
- Create: `src/pages/ProviderManager.tsx`
- Modify: `src/App.tsx`（路由）
- Modify: `src/components/Layout.tsx`（菜单项）

**Interfaces:**
- Consumes: Task 3 的 REST 契约（apiKey 脱敏返回、PUT 留空不改 Key）
- Produces: `/providers` 页面；`providerApi` 客户端

**测试说明：** 遵循代码库现状（页面级组件无自动化测试），本任务以 `npm run build` + 手动验证收口；转换层与路由层已在 Task 1/3 覆盖。

- [ ] **Step 1: `src/types/index.ts` re-export 追加**

在 re-export 列表（`ResourceOverrides,` 之后）追加：

```typescript
  LlmProvider,
  LlmProtocol,
  ProviderSource,
```

- [ ] **Step 2: 创建 `src/api/providers.ts`**

```typescript
import { api } from './client';
import type { LlmProvider, LlmProtocol } from '../types';

export interface ProviderInput {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ContinueImportResult {
  imported: LlmProvider[];
  skipped: number;
  errors: string[];
}

export const providerApi = {
  list: () => api.get<LlmProvider[]>('/providers'),
  create: (data: ProviderInput) => api.post<LlmProvider>('/providers', data),
  update: (id: string, data: Partial<ProviderInput>) => api.put<LlmProvider>(`/providers/${id}`, data),
  remove: (id: string) => api.delete<{ deleted: boolean }>(`/providers/${id}`),
  activate: (id: string) => api.post<LlmProvider>(`/providers/${id}/activate`),
  test: (id: string) => api.post<TestResult>(`/providers/${id}/test`),
  importContinue: (configPath?: string) =>
    api.post<ContinueImportResult>('/providers/import-continue', { configPath }),
};
```

- [ ] **Step 3: 创建 `src/pages/ProviderManager.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react';
import {
  Typography, Card, Button, Space, Tag, Modal, Form, Input, Select,
  InputNumber, message, Empty, Popconfirm, Spin, Alert,
} from 'antd';
import {
  PlusOutlined, ApiOutlined, CheckCircleOutlined, ThunderboltOutlined,
  ImportOutlined, DeleteOutlined, EditOutlined,
} from '@ant-design/icons';
import { providerApi, type ProviderInput, type TestResult, type ContinueImportResult } from '../api/providers';
import type { LlmProvider, LlmProtocol } from '../types';

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 协议（DeepSeek/通义/GLM/one-api…）', value: 'openai' },
  { label: 'Anthropic 协议（官方 API/兼容端点）', value: 'anthropic' },
];

export default function ProviderManager() {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await providerApi.list());
    } catch {
      message.error('加载供应商失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEditor = (p?: LlmProvider) => {
    setEditing(p ?? null);
    form.setFieldsValue(p
      ? { name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, apiKey: '', temperature: p.temperature, maxTokens: p.maxTokens }
      : { protocol: 'openai' });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = (await form.validateFields()) as ProviderInput;
      if (editing) {
        await providerApi.update(editing.id, values);
        message.success('已保存');
      } else {
        await providerApi.create(values);
        message.success('已创建');
      }
      setEditorOpen(false);
      load();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '保存失败');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const r: TestResult = await providerApi.test(id);
      if (r.ok) message.success(`连通正常 (${r.latencyMs}ms)`);
      else message.error(`连通失败: ${r.error}`);
    } catch (err: any) {
      message.error(err.message || '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await providerApi.activate(id);
      message.success('已设为当前生效');
      load();
    } catch (err: any) {
      message.error(err.message || '激活失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await providerApi.remove(id);
      load();
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
  };

  const handleImport = async () => {
    try {
      const r: ContinueImportResult = await providerApi.importContinue(importPath.trim() || undefined);
      if (r.imported.length === 0 && r.skipped === 0) {
        message.warning(r.errors[0] || '没有可导入的模型');
      } else {
        message.success(`导入 ${r.imported.length} 个，跳过重复 ${r.skipped} 个`);
      }
      if (r.errors.length > 0) console.warn('[continue-import]', r.errors);
      setImportOpen(false);
      setImportPath('');
      load();
    } catch (err: any) {
      message.error(err.message || '导入失败');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Typography.Title level={3} style={{ margin: 0 }}>模型配置</Typography.Title>
          <Typography.Text type="secondary">流水线执行时使用「当前生效」的供应商</Typography.Text>
        </Space>
        <Space>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>从 Continue 导入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建供应商</Button>
        </Space>
      </div>

      {providers.length === 0 && !loading && (
        <Alert
          type="warning" showIcon
          message="还没有配置任何大模型供应商"
          description="流水线执行需要至少一个「当前生效」的供应商。点击右上角新建，或从 Continue 配置导入。"
        />
      )}

      {loading ? <Spin style={{ display: 'block', margin: '60px auto' }} /> : (
        providers.map(p => (
          <Card
            key={p.id} size="small" style={{ marginBottom: 12 }}
            title={(
              <Space>
                <span>{p.name}</span>
                <Tag color={p.protocol === 'openai' ? 'blue' : 'purple'}>
                  {p.protocol === 'openai' ? 'OpenAI 协议' : 'Anthropic 协议'}
                </Tag>
                {p.isActive && <Tag color="success" icon={<CheckCircleOutlined />}>当前生效</Tag>}
                {p.source === 'continue' && <Tag>来自 Continue</Tag>}
              </Space>
            )}
            extra={(
              <Space>
                <Button size="small" icon={<ThunderboltOutlined />} loading={testingId === p.id} onClick={() => handleTest(p.id)}>测试</Button>
                {!p.isActive && <Button size="small" type="primary" ghost onClick={() => handleActivate(p.id)}>设为生效</Button>}
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(p)}>编辑</Button>
                <Popconfirm title="确定删除该供应商？" onConfirm={() => handleDelete(p.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            )}
          >
          <Space wrap>
            <Typography.Text type="secondary">BaseURL:</Typography.Text>
            <Typography.Text code>{p.baseUrl}</Typography.Text>
            <Typography.Text type="secondary">模型:</Typography.Text>
            <Typography.Text code>{p.model}</Typography.Text>
            <Typography.Text type="secondary">Key:</Typography.Text>
            <Typography.Text code>{p.apiKey}</Typography.Text>
          </Space>
          </Card>
        ))
      )}

      <Modal
        title={editing ? '编辑供应商' : '新建供应商'}
        open={editorOpen}
        onOk={handleSave}
        onCancel={() => setEditorOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：DeepSeek 官方" />
          </Form.Item>
          <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
            <Select options={PROTOCOL_OPTIONS} />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '如 https://api.deepseek.com' }]}>
            <Input placeholder="https://api.deepseek.com（不含 /v1 后缀路径）" />
          </Form.Item>
          <Form.Item
            name="apiKey" label="API Key"
            rules={editing ? [] : [{ required: true, message: '请输入 API Key' }]}
            extra={editing ? '留空表示不修改' : undefined}
          >
            <Input.Password placeholder={editing ? '留空不修改' : 'sk-...'} />
          </Form.Item>
          <Form.Item name="model" label="默认模型" rules={[{ required: true, message: '如 deepseek-chat' }]}>
            <Input placeholder="deepseek-chat" />
          </Form.Item>
          <Space>
            <Form.Item name="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} placeholder="可选" />
            </Form.Item>
            <Form.Item name="maxTokens" label="Max Tokens">
              <InputNumber min={1} placeholder="可选" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="从 Continue.dev 导入"
        open={importOpen}
        onOk={handleImport}
        onCancel={() => setImportOpen(false)}
        okText="解析并导入"
      >
        <Typography.Paragraph type="secondary">
          读取 Continue 的 config.yaml（默认 %USERPROFILE%\.continue\config.yaml），将其中的 chat 模型导入为供应商。协议按 provider 字段自动推断。
        </Typography.Paragraph>
        <Input
          value={importPath}
          onChange={e => setImportPath(e.target.value)}
          placeholder="config.yaml 完整路径（留空使用默认位置）"
          prefix={<ApiOutlined />}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4: 路由与菜单**

`src/App.tsx`：import 区追加 `import ProviderManager from './pages/ProviderManager';`；`/resources` 路由之后追加：

```tsx
        <Route path="/providers" element={<ProviderManager />} />
```

`src/components/Layout.tsx`：icons import 追加 `ApiOutlined`；`menuItems` 数组在「资源管理」之后插入：

```typescript
  { key: '/providers', icon: <ApiOutlined />, label: '模型配置' },
```

- [ ] **Step 5: 构建与类型验证**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc 无错误，vite build 成功

- [ ] **Step 6: 提交**

```bash
git add src/types/index.ts src/api/providers.ts src/pages/ProviderManager.tsx src/App.tsx src/components/Layout.tsx
git commit -m "feat: 前端「模型配置」页（CRUD/激活/测试/Continue 导入）"
```

---

### Task 10: bat 运维脚本 + 手动验证清单

**Files:**
- Create: `start.bat`
- Create: `stop.bat`
- Create: `restart.bat`

**Interfaces:**
- Consumes: 生产模式静态托管（Task 8）、`npm run build`、3001 端口
- Produces: 一键启停；无新代码接口

- [ ] **Step 1: 创建 `start.bat`**

```bat
@echo off
chcp 65001 >nul
setlocal
cd /d %~dp0

rem ---- 前端产物检查 ----
if not exist dist\index.html (
  echo [start] 未找到 dist 产物，正在构建前端...
  call npm run build
  if errorlevel 1 (
    echo [start] 构建失败，请检查 npm 环境。
    pause
    exit /b 1
  )
)

rem ---- 端口占用检查（幂等启动） ----
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
  echo [start] 端口 3001 已被进程 %%a 占用，服务可能已在运行。
  echo [start] 如需重启请运行 restart.bat
  pause
  exit /b 0
)

echo [start] 启动 ai-pipeline: http://localhost:3001
start "ai-pipeline" cmd /c "set NODE_ENV=production&& npx tsx server/index.ts"

rem 等待端口就绪后打开浏览器（最多等 15 秒）
set /a tries=0
:waitloop
timeout /t 1 >nul
set /a tries+=1
netstat -ano | findstr :3001 | findstr LISTENING >nul
if errorlevel 1 (
  if %tries% lss 15 goto waitloop
  echo [start] 等待超时，请查看服务窗口的报错信息。
  pause
  exit /b 1
)
start "" http://localhost:3001
echo [start] 服务已就绪。
```

- [ ] **Step 2: 创建 `stop.bat`**

```bat
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
  echo [stop] 停止进程 %%a ...
  taskkill /F /PID %%a >nul 2>&1
  set FOUND=1
)
if !FOUND!==1 (
  echo [stop] 已停止。
) else (
  echo [stop] 服务未在运行。
)
```

- [ ] **Step 3: 创建 `restart.bat`**

```bat
@echo off
chcp 65001 >nul
call %~dp0stop.bat
timeout /t 2 >nul
call %~dp0start.bat
```

- [ ] **Step 4: 手动验证清单（逐项执行并在计划中勾选）**

1. 双击 `stop.bat`（未运行时）→ 输出「服务未在运行」。
2. 双击 `start.bat` → 弹出服务窗口、构建产物存在时直接启动；约几秒后浏览器自动打开 `http://localhost:3001`，能看到前端页面（不再是 404）。
3. 再次双击 `start.bat` → 提示「端口已被占用，服务可能已在运行」。
4. 浏览器进入「模型配置」页 → 新建一个 OpenAI 协议供应商（可用真实 DeepSeek Key），点「测试」→ 显示连通正常与延迟。
5. 点「设为生效」→ 创建会话并启动 → 步骤执行时对话流正常、工具调用触发权限弹窗（说明转换代理的 tool_use 链路通）。
6. 「从 Continue 导入」→ 输入真实 Continue config.yaml 路径 → 导入清单正确。
7. `restart.bat` → 服务重启且页面恢复。
8. 检查 `.pipeline/claude-config/` 目录已创建、`~/.claude` 未被修改（对比修改时间）。
9. 停用/不配供应商时启动会话 → 收到 400 引导文案。

- [ ] **Step 5: 全量回归**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 全部 PASS / 无错误 / 构建成功

- [ ] **Step 6: 提交**

```bash
git add start.bat stop.bat restart.bat
git commit -m "feat: start/stop/restart 运维脚本（生产模式单进程）"
```

---

## 附：依赖关系

```
Task 1 (数据层) ──→ Task 3 (REST) ──→ Task 9 (前端)
      │                                    ↑
      └──→ Task 6 (代理) ──→ Task 7 (SDK 注入) ──→ Task 8 (启动接线) ──→ Task 10 (bat)
Task 2 (Continue 解析) ──→ Task 3
Task 4 (请求转换) ──→ Task 6
Task 5 (流转换)  ──→ Task 6
```

Task 1→2 可并行；Task 4、5 可并行（互不依赖）；Task 6 依赖 1/4/5；Task 9 只依赖 3。
