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
  headers?: Record<string, string>;
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
  // 自定义请求头在不同 Continue 版本里的三种写法，全部兼容
  headers?: Record<string, unknown>;
  extraHeaders?: Record<string, unknown>;
  requestOptions?: { headers?: Record<string, unknown> };
}

/** 提取条目里的自定义请求头（requestOptions.headers / headers / extraHeaders），值统一转字符串 */
function parseEntryHeaders(m: ContinueModelEntry): Record<string, string> | undefined {
  const raw = m.requestOptions?.headers ?? m.headers ?? m.extraHeaders;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.trim() || v == null) continue;
    out[k.trim()] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    const headers = parseEntryHeaders(m);
    providers.push({
      name: m.name || `${m.provider || 'openai'}/${m.model}`,
      protocol: providerKey.includes('anthropic') ? 'anthropic' : 'openai',
      baseUrl: m.apiBase || DEFAULT_BASE[providerKey] || DEFAULT_BASE.openai,
      apiKey: m.apiKey || '',
      model: m.model,
      headers,
    });
  });
  return { providers, errors };
}
