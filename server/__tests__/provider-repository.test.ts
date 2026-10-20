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

  it('update with isActive true switches exclusivity', () => {
    const a = repo.create(makeProvider({ name: 'ua' }));
    const b = repo.create(makeProvider({ name: 'ub' }));
    repo.activate(a.id);
    repo.update(b.id, { isActive: true });
    expect(repo.getActive()?.id).toBe(b.id);
    expect(repo.getById(a.id)?.isActive).toBe(false);
  });

  it('create with isActive true keeps single active invariant', () => {
    const a = repo.create(makeProvider({ name: 'ca' }));
    repo.activate(a.id);
    const c = repo.create(makeProvider({ name: 'cc', isActive: true }));
    expect(repo.getActive()?.id).toBe(c.id);
    expect(repo.getById(a.id)?.isActive).toBe(false);
  });

  it('rejects invalid protocol via CHECK constraint', () => {
    expect(() => repo.create(makeProvider({ protocol: 'grpc' as never }))).toThrow();
  });
});

describe('ProviderRepository custom headers', () => {
  it('persists and returns headers on create/get/list', () => {
    const p = repo.create(makeProvider({ name: '带头', headers: { Type: 'chat' } }));
    expect(repo.getById(p.id)?.headers).toEqual({ Type: 'chat' });
    expect(repo.list().find(x => x.id === p.id)?.headers).toEqual({ Type: 'chat' });
  });

  it('updates headers (set and clear)', () => {
    const p = repo.create(makeProvider({ name: '改头', headers: { Type: 'chat' } }));
    repo.update(p.id, { headers: { 'X-Trace': '1' } });
    expect(repo.getById(p.id)?.headers).toEqual({ 'X-Trace': '1' });
    repo.update(p.id, { headers: {} });
    expect(repo.getById(p.id)?.headers).toEqual({});
  });

  it('keeps headers when update omits them', () => {
    const p = repo.create(makeProvider({ name: '保头', headers: { Type: 'chat' } }));
    repo.update(p.id, { name: '改名' });
    expect(repo.getById(p.id)?.headers).toEqual({ Type: 'chat' });
  });
});
