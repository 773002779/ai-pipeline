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

describe('parseContinueConfig custom headers', () => {
  it('parses requestOptions.headers into provider.headers', () => {
    const yaml = `
models:
  - name: 企业网关
    provider: openai
    model: deepseek-r1
    apiKey: sk-gw
    apiBase: https://gw.example.com/v1
    requestOptions:
      headers:
        Type: chat
`;
    const { providers } = parseContinueConfig(yaml);
    expect(providers[0].headers).toEqual({ Type: 'chat' });
  });

  it('also accepts a top-level headers field and coerces values to strings', () => {
    const yaml = `
models:
  - name: 网关2
    provider: openai
    model: m1
    apiKey: k
    headers:
      Type: chat
      X-Trace: 123
`;
    const { providers } = parseContinueConfig(yaml);
    expect(providers[0].headers).toEqual({ Type: 'chat', 'X-Trace': '123' });
  });

  it('leaves headers undefined when the entry has none', () => {
    const yaml = `
models:
  - name: 普通
    provider: openai
    model: m2
    apiKey: k
`;
    const { providers } = parseContinueConfig(yaml);
    expect(providers[0].headers).toBeUndefined();
  });
});
