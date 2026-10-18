# 仪表盘统计 + Claude 对话页 + 白色主题 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ai-pipeline 中实现：① 白色主题（默认）+ 暗色可切换；② 真实仪表盘（模型 token 统计 + Top5 会话 + 时间范围可调，recharts 图表）；③ Claude 对话页（多轮流式对话、@文件引用、Edit/Write diff 审批、随时停止）。

**Architecture:** 用量在 SDK 侧采集（`agent-manager` 读 result 消息的 usage/assistant 消息的 model，写入新表 `usage_records`），由新 `StatsRepository` 聚合供仪表盘。对话页复用 sessions 表 + 内置流水线 `builtin-chat`，`agent-manager` 新增 `executeChatTurn`（`persistSession`+`resume` 多轮、`includePartialMessages` 逐 token 流式），`ChatTurnRunner` 消费事件做 WS 转发与消息/用量落库。diff 在 `canUseTool` 权限钩子内构造并随 `permission_request` 推送。

**Tech Stack:** Express + sql.js + ws + @anthropic-ai/claude-agent-sdk（服务端）；React 18 + antd 5 + recharts（新增）+ dayjs（antd 自带）（前端）；vitest。

**设计文档:** `docs/superpowers/specs/2026-10-18-dashboard-chat-theme-design.md`

## Global Constraints

- TDD：每个任务先写失败测试，再实现；测试命令 `npm test`（基线 134 全绿），类型检查 `npx tsc --noEmit` 必须干净。
- 新运行时依赖**仅允许 recharts**（Task 4 安装）；dayjs 已随 antd 存在，可直接 `import dayjs from 'dayjs'`。
- 单一生效供应商约束不变；`/api/chat` 发消息与流水线 start 一样要求存在生效供应商（400 文案一致）。
- 日期过滤/分组统一用 SQL `date(created_at, 'localtime')`（`created_at` 由 SQLite `datetime('now')` 写入为 UTC），闭区间 BETWEEN。
- 不改流水线模式的流式粒度（整块推送维持现状）；chat 模式才开 `includePartialMessages`。
- UI 文案为中文；提交信息中文 conventional commits（`feat:`/`fix:`/`test:`/`docs:`）。
- 工作分支：`feature/llm-providers`（新工作直接提交到该分支）。
- 客户端测试文件头部需要 `// @vitest-environment jsdom`（vitest 全局默认 node）。

---

### Task 1: 主题系统（白色默认 + 暗色切换）

**Files:**
- Create: `src/theme/ThemeContext.tsx`
- Create: `src/theme/__tests__/ThemeContext.test.tsx`
- Modify: `src/main.tsx`
- Modify: `index.html`
- Modify: `src/components/Layout.tsx`
- Modify: `src/pages/SessionDetail.tsx`（去硬编码色值）

**Interfaces:**
- Produces: `useThemeMode(): { theme: 'light' | 'dark'; toggle: () => void }`（后续任务可用于主题相关着色）；localStorage key `app-theme`。

- [ ] **Step 1: 写失败测试**

创建 `src/theme/__tests__/ThemeContext.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider, useThemeMode } from '../ThemeContext';

function Probe() {
  const { theme, toggle } = useThemeMode();
  return (
    <div>
      <span data-testid="mode">{theme}</span>
      <button onClick={toggle}>toggle</button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.body.dataset.theme;
  });

  it('默认 light 主题（白色）', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });

  it('切换后持久化 localStorage 并更新 body 标记', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    act(() => { screen.getByText('toggle').click(); });
    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(localStorage.getItem('app-theme')).toBe('dark');
    expect(document.body.dataset.theme).toBe('dark');
  });

  it('localStorage 为 dark 时初始为 dark', () => {
    localStorage.setItem('app-theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('dark');
  });

  it('非法存储值回退 light', () => {
    localStorage.setItem('app-theme', 'blue');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/theme/__tests__/ThemeContext.test.tsx`
Expected: FAIL（Cannot find module '../ThemeContext'）

- [ ] **Step 3: 实现 ThemeContext**

创建 `src/theme/ThemeContext.tsx`：

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'app-theme';

function readInitial(): ThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'; // 默认白色
  } catch {
    return 'light';
  }
}

interface ThemeContextValue {
  theme: ThemeMode;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(readInitial);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* 忽略 */ }
    document.body.dataset.theme = theme;
    document.body.style.background = theme === 'dark' ? '#141414' : '#f5f5f5';
  }, [theme]);

  const toggle = useCallback(() => setTheme(t => (t === 'light' ? 'dark' : 'light')), []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useThemeMode() {
  return useContext(ThemeContext);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/theme/__tests__/ThemeContext.test.tsx`
Expected: PASS 4/4

- [ ] **Step 5: 接入 main.tsx + index.html 防闪烁**

`src/main.tsx` 整体替换为：

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, theme, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { ThemeProvider, useThemeMode } from './theme/ThemeContext';

function ThemedConfig({ children }: { children: React.ReactNode }) {
  const { theme: mode } = useThemeMode();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 6 },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <ThemedConfig>
          <AntApp>
            <App />
          </AntApp>
        </ThemedConfig>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
```

`index.html` 的 `<body>` 开头插入预读脚本（在 `<div id="root">` 之前）：

```html
  <body style="background:#f5f5f5">
    <script>
      (function () {
        try {
          var t = localStorage.getItem('app-theme') === 'dark' ? 'dark' : 'light';
          document.body.dataset.theme = t;
          document.body.style.background = t === 'dark' ? '#141414' : '#f5f5f5';
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 6: Layout 去硬编码 + 切换按钮**

`src/components/Layout.tsx` 整体替换为：

```tsx
import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Typography, Space, Tag, Button, theme as antdTheme } from 'antd';
import {
  DashboardOutlined,
  BlockOutlined,
  ApartmentOutlined,
  NodeIndexOutlined,
  PlaySquareOutlined,
  SettingOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons';
import { useThemeMode } from '../theme/ThemeContext';

const { Header, Sider, Content } = AntLayout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/resources', icon: <BlockOutlined />, label: '资源管理' },
  { key: '/steps', icon: <SettingOutlined />, label: '步骤管理' },
  { key: '/pipelines', icon: <ApartmentOutlined />, label: '流水线配置' },
  { key: '/sessions', icon: <NodeIndexOutlined />, label: '会话列表' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggle } = useThemeMode();
  const { token } = antdTheme.useToken();

  const selectedKey = '/' + location.pathname.split('/')[1];

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space>
          <PlaySquareOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
          <Typography.Title level={4} style={{ margin: 0 }}>
            AI Pipeline
          </Typography.Title>
          <Tag color="blue">v1.0</Tag>
        </Space>
        <Space>
          <Typography.Text type="secondary">本地 Claude 流水线代码开发平台</Typography.Text>
          <Button
            type="text"
            icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggle}
            title={theme === 'dark' ? '切换到白色主题' : '切换到暗色主题'}
          />
        </Space>
      </Header>
      <AntLayout>
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          style={{ background: token.colorBgContainer }}
          width={200}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ background: 'transparent', borderRight: 0 }}
          />
        </Sider>
        <Content style={{ padding: 24, background: token.colorBgLayout, minHeight: 'calc(100vh - 64px)' }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
```

- [ ] **Step 7: SessionDetail 去硬编码**

`src/pages/SessionDetail.tsx`：
1. 组件内取 token：`const { token } = theme.useToken();`（从 antd 导入 `theme`）。
2. 聊天区容器：`background: '#1a1a1a'` → `background: token.colorBgLayout`。
3. 气泡样式：assistant `background: '#262626'` → `token.colorFillTertiary`；system `background: '#333'` → `token.colorFillSecondary`、`border: '1px solid #444'` → `1px solid ${token.colorBorderSecondary}`；文字 `color: '#e8e8e8'` → `token.colorText`；system `color: '#faad14'` → `token.colorWarning`。
4. 时间戳行 `color: '#888'` → `token.colorTextSecondary`。
5. 输入区 `borderTop: '1px solid #333'` → `1px solid ${token.colorBorderSecondary}`。
6. `ThinkingSection`（同文件内）：外层 `background: '#1a1a2e'` → `token.colorFillSecondary`、`border: '1px solid #333366'` → `1px solid ${token.colorBorder}`、标题色 `'#8888cc'` → `token.colorTextSecondary`、"(思考中...)" `'#6666aa'` → `token.colorTextQuaternary`、右侧 `'#666'` → `token.colorTextQuaternary`；内层 `background: '#12121f'` → `token.colorFillTertiary`、文字 `'#a0a0d0'` → `token.colorTextSecondary`。注意 `ThinkingSection` 是嵌套函数组件，直接把 `token` 作为 prop 传入：`<ThinkingSection thinking={...} streaming={...} token={token} />`，其 props 类型加 `token: ThemeToken`（`import type { ThemeToken } from 'antd/es/theme/internal'` 若类型不可用则用 `ReturnType<typeof antdTheme.useToken>['token']`）。

- [ ] **Step 8: 全量验证**

Run: `npm test && npx tsc --noEmit`
Expected: 全部测试通过（134 + 4 新增），tsc 无错。

- [ ] **Step 9: Commit**

```bash
git add src/theme src/main.tsx index.html src/components/Layout.tsx src/pages/SessionDetail.tsx
git commit -m "feat: 白色主题（默认）+ 暗色切换，去硬编码色值"
```

---

### Task 2: 用量采集（usage_records + SDK usage 提取 + executor 落库）

**Files:**
- Modify: `server/db/schema.ts`（新表 + 索引）
- Create: `server/db/repositories/usage.ts`
- Create: `server/__tests__/usage-repository.test.ts`
- Create: `server/__tests__/agent-manager-usage.test.ts`
- Modify: `server/claude/agent-manager.ts`
- Modify: `server/engine/executor.ts`
- Modify: `server/routes/sessions.ts`

**Interfaces:**
- Produces: `UsageRepository.add(record: UsageRecordInput): void`，`UsageRecordInput = { sessionId: string; stepId?: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`。
- Produces: `agent-manager` 导出 `interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`；`AgentEvent` 新增 `{ type: 'usage'; stepId: string; model: string; usage: TokenUsage }`（Task 7 的 `ChatTurnEvent` 复用 `TokenUsage`）。

- [ ] **Step 1: 写失败测试（仓库）**

`server/__tests__/usage-repository.test.ts`：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { UsageRepository } from '../db/repositories/usage';

let dbHelper: DbHelper;
let repo: UsageRepository;

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  repo = new UsageRepository(dbHelper);
});

describe('UsageRepository', () => {
  it('add 写入一行完整记录', () => {
    repo.add({
      sessionId: 'sess-1', stepId: 'step-1', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5,
    });
    const row = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'sess-1'",
    );
    expect(row).toBeDefined();
    expect(row!['model']).toBe('deepseek-chat');
    expect(row!['input_tokens']).toBe(100);
    expect(row!['output_tokens']).toBe(50);
    expect(row!['cache_read_tokens']).toBe(10);
    expect(row!['cache_creation_tokens']).toBe(5);
    expect(row!['step_id']).toBe('step-1');
    expect(row!['created_at']).toBeTruthy();
  });

  it('stepId 可省略（chat 场景）', () => {
    repo.add({
      sessionId: 'sess-2', model: 'gpt-4o',
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    const row = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'sess-2'",
    );
    expect(row!['step_id']).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/__tests__/usage-repository.test.ts`
Expected: FAIL（Cannot find module '../db/repositories/usage'）

- [ ] **Step 3: schema + 仓库实现**

`server/db/schema.ts`：`statements` 数组末尾（providers 表之后）追加：

```ts
    `CREATE TABLE usage_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
```

`indices` 数组追加：

```ts
    `CREATE INDEX idx_usage_created ON usage_records(created_at)`,
    `CREATE INDEX idx_usage_session ON usage_records(session_id)`,
```

创建 `server/db/repositories/usage.ts`：

```ts
import { v4 as uuidv4 } from 'uuid';
import { DbHelper } from '../helper';

export interface UsageRecordInput {
  sessionId: string;
  stepId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export class UsageRepository {
  constructor(private db: DbHelper) {}

  add(record: UsageRecordInput): void {
    this.db.run(
      `INSERT INTO usage_records (id, session_id, step_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), record.sessionId, record.stepId ?? null, record.model,
        record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheCreationTokens]
    );
  }
}
```

- [ ] **Step 4: agent-manager 提取 usage/model（先写失败测试）**

`server/__tests__/agent-manager-usage.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentManager } from '../claude/agent-manager';
import type { AgentEvent } from '../claude/agent-manager';
import type { StepTemplate } from '../../shared/types';

const queryMock = vi.mocked(query);

const template: StepTemplate = {
  id: 't1', name: '步骤', category: 'x', description: '', systemPrompt: 'sp',
  interactionMode: 'auto', autoAdvance: true, pauseForQuestions: false,
  collectActionItems: false, loopEnabled: false, outputFormat: 'markdown',
};

function baseConfig() {
  return {
    sessionId: 's1', stepId: 'p1', template,
    resolvedSkills: [], resolvedMcps: [],
    workspaces: [{ name: 'ws', path: process.cwd(), type: 'unknown' as const }],
    previousOutputs: [], requirement: 'req',
    wsChannel: { broadcastToSession: () => {} } as never,
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('agent-manager usage 采集', () => {
  beforeEach(() => { queryMock.mockReset(); });

  it('从 result.usage + assistant.model 产出 usage 事件', async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: 'assistant', session_id: 'sdk-1',
        message: { model: 'deepseek-chat', role: 'assistant', content: [{ type: 'text', text: '你好' }] },
      };
      yield {
        type: 'result', subtype: 'success', session_id: 'sdk-1',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }> | undefined;
    expect(usage).toBeDefined();
    expect(usage!.model).toBe('deepseek-chat');
    expect(usage!.usage).toEqual({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5,
    });
  });

  it('result 无 usage 时不出 usage 事件', async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', session_id: 'sdk-1' };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    expect(events.some(e => e.type === 'usage')).toBe(false);
  });

  it('model 缺失时回退 unknown', async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: 'assistant', session_id: 'sdk-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-1', usage: { input_tokens: 1, output_tokens: 2 } };
    } as never);

    const events = await collect(new ClaudeAgentManager().execute(baseConfig()));
    const usage = events.find(e => e.type === 'usage') as Extract<AgentEvent, { type: 'usage' }>;
    expect(usage.model).toBe('unknown');
    expect(usage.usage.outputTokens).toBe(2);
  });
});
```

Run: `npx vitest run server/__tests__/agent-manager-usage.test.ts` → FAIL（usage 事件不存在）。

- [ ] **Step 5: 实现 agent-manager 变更**

`server/claude/agent-manager.ts`：

1. 导出 TokenUsage 并扩展 AgentEvent：

```ts
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
```

AgentEvent 联合类型追加：`| { type: 'usage'; stepId: string; model: string; usage: TokenUsage }`。

2. `extractMessageData` 返回类型与实现扩展 —— 返回对象增加 `model?: string; usage?: Record<string, number>`；assistant 分支与 result 分支均取：

```ts
const model = (msg.message?.model || msg.model) as string | undefined;
const usage = (msg.usage || msg.message?.usage) as Record<string, number> | undefined;
```

assistant 分支 return 合入 `model, usage`；result 分支 return `{ type: 'result', content: ..., model, usage }`。签名改为：

```ts
private extractMessageData(message: Record<string, unknown>): {
  type: string; content?: string; thinking?: string;
  toolName?: string; toolInput?: Record<string, unknown>;
  model?: string; usage?: Record<string, number>;
}
```

3. `execute()` 中：`let tokenCount = 0;` 旁加 `let lastModel: string | undefined;`；assistant 分支里 `if (msgData.model) lastModel = msgData.model;`；result 分支（`msgData.type === 'result'`）内、在现有两个 yield 之后追加：

```ts
if (msgData.usage) {
  yield {
    type: 'usage',
    stepId,
    model: msgData.model || lastModel || 'unknown',
    usage: {
      inputTokens: msgData.usage.input_tokens ?? 0,
      outputTokens: msgData.usage.output_tokens ?? 0,
      cacheReadTokens: (msgData.usage as Record<string, number>).cache_read_input_tokens ?? 0,
      cacheCreationTokens: (msgData.usage as Record<string, number>).cache_creation_input_tokens ?? 0,
    },
  };
}
```

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run server/__tests__/agent-manager-usage.test.ts server/__tests__/agent-manager.test.ts`
Expected: 新 3 例 PASS，原有用例不受影响。

- [ ] **Step 7: executor 落库 + 路由接线**

`server/engine/executor.ts`：
1. 导入 `import { UsageRepository } from '../db/repositories/usage';`
2. 构造函数加可选参数：`private usageRepo?: UsageRepository,`
3. 事件循环内 `if (event.type === 'tool_use')` 块之后追加：

```ts
          if (event.type === 'usage' && this.usageRepo) {
            this.usageRepo.add({
              sessionId: session.id,
              stepId: pipelineStep.id,
              model: event.model,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
              cacheCreationTokens: event.usage.cacheCreationTokens,
            });
          }
```

`server/routes/sessions.ts`：导入 `UsageRepository`，`launchExecutor` 内改为：

```ts
      : new PipelineExecutor(sessionRepo, deps.resourceRepo, deps.stepRepo, new UsageRepository(dbHelper))
```

- [ ] **Step 8: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add server/db/schema.ts server/db/repositories/usage.ts server/__tests__/usage-repository.test.ts server/__tests__/agent-manager-usage.test.ts server/claude/agent-manager.ts server/engine/executor.ts server/routes/sessions.ts
git commit -m "feat: SDK 侧 token 用量采集（usage_records + usage 事件 + executor 落库）"
```

---

### Task 3: StatsRepository + /api/stats 路由

**Files:**
- Create: `server/db/repositories/stats.ts`
- Create: `server/routes/stats.ts`
- Create: `server/__tests__/stats-routes.test.ts`
- Modify: `server/app.ts`

**Interfaces:**
- Produces: `StatsRepository.overview(): { resources: number; pipelines: number; sessionsTotal: number; sessionsByStatus: Record<string, number> }`；`modelUsage(from, to): { model: string; inputTokens: number; outputTokens: number; cacheTokens: number; totalTokens: number }[]`；`dailyUsage(from, to): { date: string; model: string; tokens: number }[]`（**按日期+模型分组**，供堆叠柱图）；`topSessions(from, to, limit?): { sessionId: string; name: string; kind: 'pipeline' | 'chat'; totalTokens: number }[]`。
- Produces: REST `GET /api/stats/overview`、`GET /api/stats/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`（缺省 from=今天-6、to=今天）。

- [ ] **Step 1: 写失败测试**

`server/__tests__/stats-routes.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createStatsRoutes } from '../routes/stats';

let dbHelper: DbHelper;
let server: http.Server;
let baseUrl: string;

async function json(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);

  // 固定日期种子：3/10 两条（两个模型）、3/11 一条、3/12 一条（另一会话）
  const seed = [
    ['u1', 'sess-a', 'deepseek-chat', 100, 50, 0, 0, '2026-03-10 10:00:00'],
    ['u2', 'sess-a', 'gpt-4o', 200, 10, 5, 5, '2026-03-10 11:00:00'],
    ['u3', 'sess-a', 'deepseek-chat', 10, 5, 0, 0, '2026-03-11 09:00:00'],
    ['u4', 'sess-b', 'deepseek-chat', 500, 900, 0, 0, '2026-03-12 09:00:00'],
  ] as const;
  for (const [id, sid, model, i, o, cr, cc, at] of seed) {
    dbHelper.run(
      `INSERT INTO usage_records (id, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sid, model, i, o, cr, cc, at],
    );
  }
  dbHelper.run(
    `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status, workspaces_json, current_step_index)
     VALUES ('sess-a', 'p1', '{}', '会话A', 'r', 'completed', '[]', 0)`,
  );
  dbHelper.run(
    `INSERT INTO sessions (id, pipeline_id, pipeline_snapshot, name, requirement, status, workspaces_json, current_step_index)
     VALUES ('sess-b', 'p1', '{}', '会话B', 'r', 'completed', '[]', 0)`,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/stats', createStatsRoutes(dbHelper));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('GET /api/stats/usage', () => {
  it('按模型汇总（含 cache 合并列）', async () => {
    const { status, body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    expect(status).toBe(200);
    const models = body.data.models;
    const ds = models.find((m: any) => m.model === 'deepseek-chat');
    expect(ds.inputTokens).toBe(610);
    expect(ds.outputTokens).toBe(955);
    expect(ds.totalTokens).toBe(610 + 955);
    const gpt = models.find((m: any) => m.model === 'gpt-4o');
    expect(gpt.cacheTokens).toBe(10);
    expect(gpt.totalTokens).toBe(220);
  });

  it('按日期+模型分组（堆叠图数据）', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    const rows = body.data.daily;
    expect(rows).toContainEqual({ date: '2026-03-10', model: 'deepseek-chat', tokens: 150 });
    expect(rows).toContainEqual({ date: '2026-03-10', model: 'gpt-4o', tokens: 220 });
    expect(rows).toContainEqual({ date: '2026-03-12', model: 'deepseek-chat', tokens: 1400 });
  });

  it('Top5 会话按总量排序并带 kind', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-10&to=2026-03-12');
    const top = body.data.topSessions;
    expect(top[0]).toMatchObject({ sessionId: 'sess-b', name: '会话B', kind: 'pipeline' });
    expect(top[0].totalTokens).toBe(1400);
    expect(top[1]).toMatchObject({ sessionId: 'sess-a', name: '会话A' });
    expect(top.length).toBeLessThanOrEqual(5);
  });

  it('日期闭区间边界生效', async () => {
    const { body } = await json('/api/stats/usage?from=2026-03-11&to=2026-03-11');
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0].inputTokens).toBe(10);
  });

  it('非法日期 400', async () => {
    const { status } = await json('/api/stats/usage?from=bad&to=2026-03-10');
    expect(status).toBe(400);
  });
});

describe('GET /api/stats/overview', () => {
  it('返回真实计数', async () => {
    const { body } = await json('/api/stats/overview');
    expect(body.data.sessionsTotal).toBe(2);
    expect(body.data.sessionsByStatus.completed).toBe(2);
    expect(body.data.resources).toBe(0);
    expect(body.data.pipelines).toBe(0);
  });
});
```

Run: `npx vitest run server/__tests__/stats-routes.test.ts` → FAIL（模块不存在）。

- [ ] **Step 2: 实现 StatsRepository**

`server/db/repositories/stats.ts`：

```ts
import { DbHelper } from '../helper';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../../shared/types';

const TOKEN_SUM = "SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)";

export class StatsRepository {
  constructor(private db: DbHelper) {}

  overview(): { resources: number; pipelines: number; sessionsTotal: number; sessionsByStatus: Record<string, number> } {
    const resources = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM resources')?.n ?? 0;
    const pipelines = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pipelines WHERE id != ?', [BUILTIN_CHAT_PIPELINE_ID])?.n ?? 0;
    const statusRows = this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM sessions GROUP BY status');
    const sessionsByStatus: Record<string, number> = {};
    let sessionsTotal = 0;
    for (const r of statusRows) { sessionsByStatus[r.status] = r.n; sessionsTotal += r.n; }
    return { resources, pipelines, sessionsTotal, sessionsByStatus };
  }

  modelUsage(from: string, to: string): Array<{ model: string; inputTokens: number; outputTokens: number; cacheTokens: number; totalTokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT model,
              SUM(input_tokens) AS inputTokens,
              SUM(output_tokens) AS outputTokens,
              SUM(cache_read_tokens + cache_creation_tokens) AS cacheTokens,
              ${TOKEN_SUM} AS totalTokens
       FROM usage_records
       WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY model
       ORDER BY totalTokens DESC`,
      [from, to],
    ).map(r => ({
      model: r['model'] as string,
      inputTokens: Number(r['inputTokens'] ?? 0),
      outputTokens: Number(r['outputTokens'] ?? 0),
      cacheTokens: Number(r['cacheTokens'] ?? 0),
      totalTokens: Number(r['totalTokens'] ?? 0),
    }));
  }

  dailyUsage(from: string, to: string): Array<{ date: string; model: string; tokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT date(created_at, 'localtime') AS date, model, ${TOKEN_SUM} AS tokens
       FROM usage_records
       WHERE date(created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY date(created_at, 'localtime'), model
       ORDER BY date`,
      [from, to],
    ).map(r => ({
      date: r['date'] as string,
      model: r['model'] as string,
      tokens: Number(r['tokens'] ?? 0),
    }));
  }

  topSessions(from: string, to: string, limit = 5): Array<{ sessionId: string; name: string; kind: 'pipeline' | 'chat'; totalTokens: number }> {
    return this.db.all<Record<string, unknown>>(
      `SELECT ur.session_id AS sessionId, s.name AS name, s.pipeline_id AS pipelineId, ${TOKEN_SUM} AS totalTokens
       FROM usage_records ur
       JOIN sessions s ON s.id = ur.session_id
       WHERE date(ur.created_at, 'localtime') BETWEEN ? AND ?
       GROUP BY ur.session_id
       ORDER BY totalTokens DESC
       LIMIT ?`,
      [from, to, limit],
    ).map(r => ({
      sessionId: r['sessionId'] as string,
      name: (r['name'] as string) || '',
      kind: r['pipelineId'] === BUILTIN_CHAT_PIPELINE_ID ? 'chat' as const : 'pipeline' as const,
      totalTokens: Number(r['totalTokens'] ?? 0),
    }));
  }
}
```

注意：`BUILTIN_CHAT_PIPELINE_ID` 在 Task 5 才加入 shared/types —— 本任务先在 `shared/types.ts` 顶部加这一行（Task 5 会复用）：

```ts
// 内置「自由对话」流水线 id（Claude 对话页专用）
export const BUILTIN_CHAT_PIPELINE_ID = 'builtin-chat';
```

- [ ] **Step 3: 实现路由 + 接线**

`server/routes/stats.ts`：

```ts
import { Router, Request, Response } from 'express';
import { StatsRepository } from '../db/repositories/stats';
import type { DbHelper } from '../db/helper';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createStatsRoutes(dbHelper: DbHelper): Router {
  const router = Router();
  const repo = new StatsRepository(dbHelper);

  router.get('/overview', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: repo.overview() });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.get('/usage', (req: Request, res: Response) => {
    try {
      const to = (req.query.to as string) || toLocalDate(new Date());
      const from = (req.query.from as string) || toLocalDate(new Date(Date.now() - 6 * 86400_000));
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
        return res.status(400).json({ success: false, error: 'from/to 必须是 YYYY-MM-DD' });
      }
      res.json({
        success: true,
        data: {
          models: repo.modelUsage(from, to),
          daily: repo.dailyUsage(from, to),
          topSessions: repo.topSessions(from, to, 5),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
```

`server/app.ts`：导入 `createStatsRoutes`，dbHelper 分支内追加：

```ts
    app.use('/api/stats', createStatsRoutes(options.dbHelper));
```

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add server/db/repositories/stats.ts server/routes/stats.ts server/__tests__/stats-routes.test.ts server/app.ts shared/types.ts
git commit -m "feat: /api/stats 统计接口（overview + 按模型/按日用量 + Top5 会话）"
```

---

### Task 4: 仪表盘前端（真实数据 + recharts）

**Files:**
- Modify: `package.json`（安装 recharts）
- Create: `src/api/stats.ts`
- Modify: `src/pages/Dashboard.tsx`（整体重写）

**Interfaces:**
- Consumes: Task 3 的 REST 接口。

- [ ] **Step 1: 安装 recharts**

Run: `npm install recharts`
Expected: package.json dependencies 出现 recharts。

- [ ] **Step 2: stats API client**

`src/api/stats.ts`：

```ts
import { api } from './client';

export interface StatsOverview {
  resources: number;
  pipelines: number;
  sessionsTotal: number;
  sessionsByStatus: Record<string, number>;
}
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
}
export interface DailyUsage { date: string; model: string; tokens: number; }
export interface TopSession {
  sessionId: string;
  name: string;
  kind: 'pipeline' | 'chat';
  totalTokens: number;
}
export interface UsageStats {
  models: ModelUsage[];
  daily: DailyUsage[];
  topSessions: TopSession[];
}

export const statsApi = {
  overview: () => api.get<StatsOverview>('/stats/overview'),
  usage: (range: { from: string; to: string }) =>
    api.get<UsageStats>(`/stats/usage?from=${range.from}&to=${range.to}`),
};
```

- [ ] **Step 3: 重写 Dashboard.tsx**

`src/pages/Dashboard.tsx` 整体替换为：

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Row, Col, Statistic, Typography, Segmented, DatePicker, Table, List,
  Tag, Empty, Spin, message, Space, theme as antdTheme,
} from 'antd';
import {
  BlockOutlined, ApartmentOutlined, SyncOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import dayjs, { type Dayjs } from 'dayjs';
import { statsApi, type StatsOverview, type UsageStats } from '../api/stats';

type RangeKey = 'today' | 'd7' | 'd30' | 'all' | 'custom';

const COLORS = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#722ed1', '#13c2c2', '#fa8c16', '#2f54eb'];
const fmt = (d: Dayjs) => d.format('YYYY-MM-DD');

export default function Dashboard() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [rangeKey, setRangeKey] = useState<RangeKey>('d7');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo<{ from: string; to: string }>(() => {
    const today = dayjs();
    switch (rangeKey) {
      case 'today': return { from: fmt(today), to: fmt(today) };
      case 'd30': return { from: fmt(today.subtract(29, 'day')), to: fmt(today) };
      case 'all': return { from: '1970-01-01', to: fmt(today) };
      case 'custom':
        return customRange
          ? { from: fmt(customRange[0]), to: fmt(customRange[1]) }
          : { from: fmt(today.subtract(6, 'day')), to: fmt(today) };
      default: return { from: fmt(today.subtract(6, 'day')), to: fmt(today) };
    }
  }, [rangeKey, customRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, us] = await Promise.all([statsApi.overview(), statsApi.usage(range)]);
      setOverview(ov);
      setUsage(us);
    } catch {
      message.error('加载统计数据失败');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // daily: [{date, model, tokens}] → [{date, [model]: tokens}] 供堆叠柱图
  const pivoted = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const r of usage?.daily || []) {
      if (!map.has(r.date)) map.set(r.date, { date: r.date });
      (map.get(r.date) as Record<string, unknown>)[r.model] = r.tokens;
    }
    return Array.from(map.values());
  }, [usage]);

  const modelNames = useMemo(() => (usage?.models || []).map(m => m.model), [usage]);

  if (loading && !overview) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;

  return (
    <div>
      <Typography.Title level={3}>仪表盘</Typography.Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="资源总数" value={overview?.resources ?? 0} prefix={<BlockOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="流水线模板" value={overview?.pipelines ?? 0} prefix={<ApartmentOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="活跃会话" value={overview?.sessionsByStatus?.running ?? 0}
              prefix={<SyncOutlined spin={(overview?.sessionsByStatus?.running ?? 0) > 0} />}
              valueStyle={{ color: token.colorPrimary }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="已完成会话" value={overview?.sessionsByStatus?.completed ?? 0}
              prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented
            value={rangeKey}
            onChange={(v) => setRangeKey(v as RangeKey)}
            options={[
              { label: '今天', value: 'today' },
              { label: '近7天', value: 'd7' },
              { label: '近30天', value: 'd30' },
              { label: '全部', value: 'all' },
            ]}
          />
          <DatePicker.RangePicker
            value={customRange}
            allowClear={false}
            onChange={(v) => {
              if (v && v[0] && v[1]) {
                setCustomRange([v[0], v[1] as Dayjs]);
                setRangeKey('custom');
              }
            }}
          />
        </Space>

        <Typography.Title level={5}>每日 Token 消耗（按模型堆叠）</Typography.Title>
        {pivoted.length === 0 ? (
          <Empty description="所选时间范围内暂无用量数据（统计自功能上线起累积）" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={pivoted}>
              <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: token.colorTextSecondary }} />
              <YAxis tick={{ fontSize: 11, fill: token.colorTextSecondary }} />
              <Tooltip />
              <Legend />
              {modelNames.map((m, i) => (
                <Bar key={m} dataKey={m} stackId="t" fill={COLORS[i % COLORS.length]} name={m} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="模型用量明细" size="small">
            <Table
              rowKey="model"
              size="small"
              dataSource={usage?.models || []}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              columns={[
                { title: '模型', dataIndex: 'model' },
                { title: '输入', dataIndex: 'inputTokens', render: (v: number) => v.toLocaleString() },
                { title: '输出', dataIndex: 'outputTokens', render: (v: number) => v.toLocaleString() },
                { title: '缓存', dataIndex: 'cacheTokens', render: (v: number) => v.toLocaleString() },
                {
                  title: '合计', dataIndex: 'totalTokens', defaultSortOrder: 'descend',
                  sorter: (a: any, b: any) => a.totalTokens - b.totalTokens,
                  render: (v: number) => v.toLocaleString(),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="Top5 Token 消耗会话" size="small">
            <List
              dataSource={usage?.topSessions || []}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              renderItem={(item) => (
                <List.Item
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(item.kind === 'chat' ? `/chat/${item.sessionId}` : `/sessions/${item.sessionId}`)}
                  actions={[<Typography.Text key="t" type="secondary">{item.totalTokens.toLocaleString()} tokens</Typography.Text>]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Typography.Text ellipsis style={{ maxWidth: 260 }}>
                          {item.name || '未命名会话'}
                        </Typography.Text>
                        <Tag color={item.kind === 'chat' ? 'purple' : 'blue'}>
                          {item.kind === 'chat' ? '对话' : '流水线'}
                        </Tag>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
```

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit && npm run build` → 全绿（build 含 recharts 打包）。

```bash
git add package.json package-lock.json src/api/stats.ts src/pages/Dashboard.tsx
git commit -m "feat: 仪表盘真实数据 + token 统计图表（recharts）+ Top5 会话"
```

---

### Task 5: chat 会话基础（类型/迁移/内置流水线/chat CRUD 路由）

**Files:**
- Modify: `shared/types.ts`（Session 字段）
- Modify: `src/types/index.ts`（re-export）
- Modify: `server/db/schema.ts`（sessions 加列 migration）
- Modify: `server/db/repositories/sessions.ts`
- Create: `server/chat/builtin-pipeline.ts`
- Create: `server/routes/chat.ts`（本任务先实现 create/list/model/delete）
- Create: `server/__tests__/chat-session-repository.test.ts`
- Create: `server/__tests__/chat-routes.test.ts`（本任务先测 CRUD，Task 7 补 messages/stop）
- Modify: `server/routes/pipelines.ts`（过滤 + 保护内置流水线）
- Modify: `server/app.ts`、`server/index.ts`

**Interfaces:**
- Consumes: Task 3 加入的 `BUILTIN_CHAT_PIPELINE_ID`。
- Produces: `Session.chatSdkSessionId?: string; Session.chatModel?: string`；`ensureBuiltinChatPipeline(db: DbHelper): Pipeline`；`SessionRepository.updateChatFields(id, fields: { chatSdkSessionId?: string; chatModel?: string }): Session | null`；`SessionRepository.listByPipeline(pipelineId): Session[]`；`SessionRepository.deleteCascade(id): boolean`；REST `POST /api/chat/sessions`、`GET /api/chat/sessions`、`PUT /api/chat/:id/model`、`DELETE /api/chat/:id`。

- [ ] **Step 1: 类型与迁移**

`shared/types.ts` Session 接口追加两个字段（`stepOverrides` 之后）：

```ts
  chatSdkSessionId?: string;   // Claude 对话：SDK 会话句柄（多轮 resume）
  chatModel?: string;          // Claude 对话：会话级模型覆盖
```

`src/types/index.ts` 的 re-export 列表加 `BUILTIN_CHAT_PIPELINE_ID`（注意它是值不是类型，需单独 export 语句）：

```ts
export { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
```

`server/db/schema.ts` 迁移区（现有 thinking_json ALTER 之后）追加：

```ts
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_sdk_session_id TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN chat_model TEXT");
  } catch (_e) {
    // Column already exists — ignore
  }
```

- [ ] **Step 2: SessionRepository 扩展（先写失败测试）**

`server/__tests__/chat-session-repository.test.ts`：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Session } from '../../shared/types';

let dbHelper: DbHelper;
let repo: SessionRepository;

function chatSession(id: string): Session {
  return {
    id, pipelineId: BUILTIN_CHAT_PIPELINE_ID,
    pipelineSnapshot: { id: BUILTIN_CHAT_PIPELINE_ID, name: '自由对话', description: '', steps: [], createdAt: '', updatedAt: '' },
    name: '新对话', requirement: '', status: 'idle',
    workspaces: [{ name: 'ws', path: 'D:/tmp', type: 'unknown' }],
    currentStepIndex: 0, steps: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  repo = new SessionRepository(dbHelper);
});

describe('chat 会话仓库扩展', () => {
  it('create 持久化 chat 字段并回读', () => {
    const s = chatSession('c1');
    s.chatModel = 'deepseek-chat';
    repo.create(s);
    const loaded = repo.getById('c1');
    expect(loaded!.chatModel).toBe('deepseek-chat');
    expect(loaded!.chatSdkSessionId).toBeUndefined();
  });

  it('updateChatFields 更新模型与 sdk 会话句柄', () => {
    repo.create(chatSession('c2'));
    repo.updateChatFields('c2', { chatSdkSessionId: 'sdk-abc' });
    repo.updateChatFields('c2', { chatModel: 'gpt-4o' });
    const loaded = repo.getById('c2');
    expect(loaded!.chatSdkSessionId).toBe('sdk-abc');
    expect(loaded!.chatModel).toBe('gpt-4o');
  });

  it('listByPipeline 只返回指定流水线的会话', () => {
    repo.create(chatSession('c3'));
    const list = repo.listByPipeline(BUILTIN_CHAT_PIPELINE_ID);
    expect(list.map(s => s.id)).toContain('c3');
    // 不含非 chat 会话
    expect(list.every(s => s.pipelineId === BUILTIN_CHAT_PIPELINE_ID)).toBe(true);
  });

  it('deleteCascade 级联删除消息等关联数据', () => {
    repo.create(chatSession('c4'));
    repo.addMessage('c4', null, 'user', 'hello');
    dbHelper.run(`INSERT INTO usage_records (id, session_id, model) VALUES ('u-c4', 'c4', 'm')`);
    expect(repo.deleteCascade('c4')).toBe(true);
    expect(repo.getById('c4')).toBeNull();
    expect(dbHelper.get("SELECT * FROM messages WHERE session_id = 'c4'")).toBeUndefined();
    expect(dbHelper.get("SELECT * FROM usage_records WHERE session_id = 'c4'")).toBeUndefined();
    expect(repo.deleteCascade('c4')).toBe(false);
  });
});
```

Run: `npx vitest run server/__tests__/chat-session-repository.test.ts` → FAIL（方法不存在）。

实现 `server/db/repositories/sessions.ts`：
1. `create()` INSERT 列与值追加 `chat_sdk_session_id, chat_model`（参数 `session.chatSdkSessionId ?? null, session.chatModel ?? null`）。
2. `getById()` 返回对象追加：

```ts
      chatSdkSessionId: (row['chat_sdk_session_id'] as string) || undefined,
      chatModel: (row['chat_model'] as string) || undefined,
```

3. 新方法：

```ts
  updateChatFields(id: string, fields: { chatSdkSessionId?: string; chatModel?: string }): Session | null {
    const existing = this.getById(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    this.db.run(
      'UPDATE sessions SET chat_sdk_session_id=?, chat_model=?, updated_at=? WHERE id=?',
      [updated.chatSdkSessionId ?? null, updated.chatModel ?? null, updated.updatedAt, id]
    );
    return updated;
  }

  listByPipeline(pipelineId: string): Session[] {
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM sessions WHERE pipeline_id = ? ORDER BY updated_at DESC', [pipelineId]
    );
    return rows.map(r => this.getById(r.id)).filter((s): s is Session => s !== null);
  }

  deleteCascade(id: string): boolean {
    if (!this.getById(id)) return false;
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM usage_records WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM permission_whitelist WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM action_items WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM session_steps WHERE session_id = ?', [id]);
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return true;
  }
```

Run 确认 PASS。

- [ ] **Step 3: 内置流水线（先写失败测试）**

在 `server/__tests__/chat-session-repository.test.ts` 末尾追加（或独立 describe）：

```ts
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';

describe('ensureBuiltinChatPipeline', () => {
  it('首次创建，幂等返回同一条', () => {
    const p1 = ensureBuiltinChatPipeline(dbHelper);
    expect(p1.id).toBe(BUILTIN_CHAT_PIPELINE_ID);
    expect(p1.name).toBe('自由对话');
    expect(p1.steps).toHaveLength(0);
    const p2 = ensureBuiltinChatPipeline(dbHelper);
    expect(p2.id).toBe(p1.id);
    // 不会重复插入
    const all = dbHelper.all<Record<string, unknown>>(
      `SELECT id FROM pipelines WHERE id = '${BUILTIN_CHAT_PIPELINE_ID}'`,
    );
    expect(all).toHaveLength(1);
  });
});
```

Run → FAIL。创建 `server/chat/builtin-pipeline.ts`：

```ts
import { DbHelper } from '../db/helper';
import { PipelineRepository } from '../db/repositories/pipelines';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Pipeline } from '../../shared/types';

/** 幂等创建内置「自由对话」流水线；已存在则原样返回 */
export function ensureBuiltinChatPipeline(db: DbHelper): Pipeline {
  const repo = new PipelineRepository(db);
  const existing = repo.getById(BUILTIN_CHAT_PIPELINE_ID);
  if (existing) return existing;
  const now = new Date().toISOString();
  return repo.create({
    id: BUILTIN_CHAT_PIPELINE_ID,
    name: '自由对话',
    description: '内置：Claude 对话页专用（不可编辑）',
    steps: [],
    createdAt: now,
    updatedAt: now,
  });
}
```

- [ ] **Step 4: chat CRUD 路由（先写失败测试）**

`server/__tests__/chat-routes.test.ts`（骨架 + CRUD 用例；Task 7 会在此文件追加 messages/stop 用例）：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { createChatRoutes } from '../routes/chat';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';

let dbHelper: DbHelper;
let server: http.Server;
let baseUrl: string;

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  const app = express();
  app.use(express.json());
  app.use('/api/chat', createChatRoutes({ dbHelper }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => { server?.close(); });

describe('chat 会话 CRUD', () => {
  it('POST /sessions 创建对话（挂在内置流水线下）', async () => {
    const { status, body } = await req('POST', '/api/chat/sessions', {
      workspaces: [{ name: 'demo', path: 'D:/tmp', type: 'unknown' }],
      model: 'deepseek-chat',
    });
    expect(status).toBe(201);
    expect(body.data.pipelineId).toBe(BUILTIN_CHAT_PIPELINE_ID);
    expect(body.data.chatModel).toBe('deepseek-chat');
    expect(body.data.status).toBe('idle');
  });

  it('POST /sessions 无工作目录 400', async () => {
    const { status } = await req('POST', '/api/chat/sessions', { workspaces: [] });
    expect(status).toBe(400);
  });

  it('GET /sessions 只列对话会话', async () => {
    await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const { body } = await req('GET', '/api/chat/sessions');
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    expect(body.data.every((s: any) => s.pipelineId === BUILTIN_CHAT_PIPELINE_ID)).toBe(true);
  });

  it('PUT /:id/model 更新会话级模型', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    const { body } = await req('PUT', `/api/chat/${id}/model`, { model: 'gpt-4o' });
    expect(body.data.chatModel).toBe('gpt-4o');
  });

  it('DELETE /:id 删除对话；流水线会话 id 404', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: 'D:/tmp', type: 'unknown' }] });
    const id = created.body.data.id;
    expect((await req('DELETE', `/api/chat/${id}`)).status).toBe(200);
    expect((await req('GET', `/api/chat/sessions`)).body.data.every((s: any) => s.id !== id)).toBe(true);
  });
});
```

Run → FAIL。创建 `server/routes/chat.ts`：

```ts
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SessionRepository } from '../db/repositories/sessions';
import { ProviderRepository } from '../db/repositories/providers';
import { ensureBuiltinChatPipeline } from '../chat/builtin-pipeline';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { DbHelper } from '../db/helper';
import type { Session, SessionChannel } from '../../shared/types';
import type { ChatTurnRunner } from '../chat/turn-runner';
import type { ClaudeAgentManager } from '../claude/agent-manager';

export interface ChatRouteDeps {
  dbHelper: DbHelper;
  providerRepo?: ProviderRepository;
  wsChannel?: SessionChannel;
  /** 测试注入点：默认 new ClaudeAgentManager() */
  agentManager?: ClaudeAgentManager;
  /** 测试注入点：默认内部构造 */
  runner?: ChatTurnRunner;
}

export function createChatRoutes(deps: ChatRouteDeps): Router {
  const router = Router();
  const sessionRepo = new SessionRepository(deps.dbHelper);
  const builtinPipeline = ensureBuiltinChatPipeline(deps.dbHelper);

  function requireActiveProvider(res: Response): boolean {
    if (deps.providerRepo && !deps.providerRepo.getActive()) {
      res.status(400).json({ success: false, error: '未配置生效的大模型供应商，请在「模型配置」页激活' });
      return false;
    }
    return true;
  }

  function isChatSession(s: Session | null): s is Session {
    return !!s && s.pipelineId === BUILTIN_CHAT_PIPELINE_ID;
  }

  // 创建对话
  router.post('/sessions', (req: Request, res: Response) => {
    try {
      const { workspaces, model } = req.body || {};
      if (!Array.isArray(workspaces) || workspaces.length === 0 || !workspaces[0]?.path) {
        return res.status(400).json({ success: false, error: 'workspaces 至少需要一项（含 path）' });
      }
      const now = new Date().toISOString();
      const session: Session = {
        id: uuidv4(),
        pipelineId: BUILTIN_CHAT_PIPELINE_ID,
        pipelineSnapshot: builtinPipeline,
        name: '新对话',
        requirement: '',
        status: 'idle',
        workspaces,
        currentStepIndex: 0,
        steps: [],
        chatModel: model || undefined,
        createdAt: now,
        updatedAt: now,
      };
      sessionRepo.create(session);
      res.status(201).json({ success: true, data: session });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 对话列表
  router.get('/sessions', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, data: sessionRepo.listByPipeline(BUILTIN_CHAT_PIPELINE_ID) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 更新会话级模型（对后续轮次生效）
  router.put('/:id/model', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const { model } = req.body || {};
      const updated = sessionRepo.updateChatFields(session.id, { chatModel: model || undefined });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 删除对话（级联消息/用量/白名单等）
  router.delete('/:id', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      sessionRepo.deleteCascade(session.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
```

注意：`ChatTurnRunner`/`ClaudeAgentManager` 的 import 在 Task 7 才会真正用到，本任务先不加这两个 import 与 deps 字段（Step 4 的文件不含 `runner`；deps 接口里相关字段随 Task 7 一起加）。上面类型 import 行**本任务不要写**，避免 tsc 报缺失模块 —— `ChatRouteDeps` 本任务为 `{ dbHelper, providerRepo? }`。

- [ ] **Step 5: 接线 + 流水线保护**

`server/app.ts`：

```ts
import { createChatRoutes } from './routes/chat';
// dbHelper 分支内：
    app.use('/api/chat', createChatRoutes({ dbHelper: options.dbHelper, providerRepo }));
```

`server/routes/pipelines.ts`：
1. 导入 `import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';`
2. GET `/` 改为 `const pipelines = repo.list().filter(p => p.id !== BUILTIN_CHAT_PIPELINE_ID);`
3. PUT `/:id` 与 DELETE `/:id` 开头加保护：

```ts
      if (req.params.id === BUILTIN_CHAT_PIPELINE_ID) {
        return res.status(400).json({ success: false, error: '内置流水线不可修改' });
      }
```

`server/index.ts`：导入 `ensureBuiltinChatPipeline`，在 step loader 之后调用：

```ts
  ensureBuiltinChatPipeline(dbHelper);
  console.log('Builtin chat pipeline ensured');
```

- [ ] **Step 6: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿（含既有 pipelines 相关测试）。

```bash
git add shared/types.ts src/types/index.ts server/db/schema.ts server/db/repositories/sessions.ts server/chat/builtin-pipeline.ts server/routes/chat.ts server/routes/pipelines.ts server/app.ts server/index.ts server/__tests__/chat-session-repository.test.ts server/__tests__/chat-routes.test.ts
git commit -m "feat: chat 会话基础（内置自由对话流水线 + 会话字段 + chat CRUD 路由）"
```

---

### Task 6: 文件树 + @文件引用解析

**Files:**
- Create: `server/fs/tree.ts`
- Create: `server/routes/fs.ts`
- Create: `server/chat/mentions.ts`
- Create: `server/__tests__/fs-tree.test.ts`
- Create: `server/__tests__/mentions.test.ts`
- Modify: `shared/types.ts`（FsNode）
- Modify: `src/types/index.ts`
- Modify: `server/app.ts`

**Interfaces:**
- Produces: `FsNode { name: string; path: string; type: 'file' | 'dir'; children?: FsNode[] }`（shared）；`listTree(root: string, maxDepth?, maxEntries?): FsNode`；`parseMentions(content: string, root: string): { files: string[]; invalid: string[]; missing: string[] }`；`buildReferencedFilesBlock(files: string[]): string`；REST `GET /api/fs/tree?root=`。

- [ ] **Step 1: shared 类型**

`shared/types.ts` 追加：

```ts
// ---- 文件树 (FsNode) ----

export interface FsNode {
  name: string;
  path: string;      // 绝对路径
  type: 'file' | 'dir';
  children?: FsNode[];
}
```

`src/types/index.ts` 的 type re-export 列表加 `FsNode`。

- [ ] **Step 2: 写失败测试**

`server/__tests__/fs-tree.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listTree } from '../fs/tree';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsw-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'r');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.writeFileSync(path.join(root, '.git', 'config'), 'x');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('listTree', () => {
  it('递归列出文件与目录', () => {
    const tree = listTree(root);
    expect(tree.type).toBe('dir');
    const names = (tree.children || []).map(c => c.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    const src = (tree.children || []).find(c => c.name === 'src');
    expect(src!.children!.map(c => c.name)).toContain('a.ts');
  });

  it('忽略 node_modules/.git/dist 等目录', () => {
    const names = (listTree(root).children || []).map(c => c.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('maxDepth 限制递归深度', () => {
    fs.mkdirSync(path.join(root, 'd1', 'd2', 'd3'), { recursive: true });
    fs.writeFileSync(path.join(root, 'd1', 'd2', 'd3', 'deep.ts'), 'x');
    const tree = listTree(root, 2);
    const d1 = (tree.children || []).find(c => c.name === 'd1');
    const d2 = (d1!.children || []).find(c => c.name === 'd2');
    // depth=2 时 d2 的子层不再展开
    expect((d2!.children || []).find(c => c.name === 'd3')?.children).toBeUndefined();
  });
});
```

`server/__tests__/mentions.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMentions, buildReferencedFilesBlock } from '../chat/mentions';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'a');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'b');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('parseMentions', () => {
  it('解析存在的文件为绝对路径并去重', () => {
    const r = parseMentions('看一下 @a.ts 和 @src/b.ts，再看看 @a.ts', root);
    expect(r.files).toEqual([path.join(root, 'a.ts'), path.join(root, 'src', 'b.ts')]);
  });

  it('拒绝 ../ 路径逃逸', () => {
    const r = parseMentions('@../outside.txt', root);
    expect(r.files).toHaveLength(0);
    expect(r.invalid).toContain('../outside.txt');
  });

  it('不存在的引用进入 missing', () => {
    const r = parseMentions('@not-exist.ts', root);
    expect(r.files).toHaveLength(0);
    expect(r.missing).toContain('not-exist.ts');
  });

  it('目录引用不算命中', () => {
    const r = parseMentions('@src', root);
    expect(r.files).toHaveLength(0);
    expect(r.missing).toContain('src');
  });
});

describe('buildReferencedFilesBlock', () => {
  it('空列表返回空串', () => {
    expect(buildReferencedFilesBlock([])).toBe('');
  });

  it('生成引用块', () => {
    const block = buildReferencedFilesBlock(['/x/a.ts']);
    expect(block).toContain('## Referenced Files');
    expect(block).toContain('- /x/a.ts');
  });
});
```

Run both → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`server/fs/tree.ts`：

```ts
import fs from 'fs';
import path from 'path';
import type { FsNode } from '../../shared/types';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.pipeline', '.venv', 'venv',
]);

/** 递归列出目录树；忽略常见依赖/构建目录；深度与条目数设上限 */
export function listTree(root: string, maxDepth = 8, maxEntries = 2000): FsNode {
  let count = 0;
  const walk = (dir: string, depth: number): FsNode => {
    const node: FsNode = { name: path.basename(dir) || dir, path: dir, type: 'dir', children: [] };
    if (depth >= maxDepth || count >= maxEntries) return node;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return node; // 无权限等：按空目录处理
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    );
    for (const e of entries) {
      if (count >= maxEntries) break;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) node.children!.push(walk(full, depth + 1));
      else node.children!.push({ name: e.name, path: full, type: 'file' });
    }
    return node;
  };
  return walk(root, 0);
}
```

`server/routes/fs.ts`：

```ts
import { Router, Request, Response } from 'express';
import fs from 'fs';
import { listTree } from '../fs/tree';

export function createFsRoutes(): Router {
  const router = Router();

  router.get('/tree', (req: Request, res: Response) => {
    try {
      const root = req.query.root as string;
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        return res.status(400).json({ success: false, error: 'root 必须是已存在的目录' });
      }
      res.json({ success: true, data: listTree(root) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
```

`server/chat/mentions.ts`：

```ts
import fs from 'fs';
import path from 'path';

export interface MentionResolution {
  files: string[];    // 解析成功的绝对路径（去重、保序）
  invalid: string[];  // 越界/非法引用（拒绝）
  missing: string[];  // 不存在或不是文件的引用（忽略）
}

const MENTION_RE = /(^|\s)@([^\s@]+)/g;

/** 解析消息中的 @path 引用；强制解析结果位于 root 内（防路径逃逸） */
export function parseMentions(content: string, root: string): MentionResolution {
  const files: string[] = [];
  const invalid: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const normalizedRoot = path.resolve(root);

  for (const match of content.matchAll(MENTION_RE)) {
    const rel = match[2];
    const abs = path.resolve(normalizedRoot, rel);
    if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
      if (!invalid.includes(rel)) invalid.push(rel);
      continue;
    }
    let isFile = false;
    try { isFile = fs.existsSync(abs) && fs.statSync(abs).isFile(); } catch { isFile = false; }
    if (!isFile) {
      if (!missing.includes(rel)) missing.push(rel);
      continue;
    }
    if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  }
  return { files, invalid, missing };
}

/** 生成提示 Claude 先读取引用文件的 prompt 块 */
export function buildReferencedFilesBlock(files: string[]): string {
  if (files.length === 0) return '';
  return ['## Referenced Files', 'Please read these files first:', ...files.map(f => `- ${f}`)].join('\n');
}
```

`server/app.ts`：

```ts
import { createFsRoutes } from './routes/fs';
// dbHelper 分支内：
    app.use('/api/fs', createFsRoutes());
```

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add server/fs/tree.ts server/routes/fs.ts server/chat/mentions.ts server/__tests__/fs-tree.test.ts server/__tests__/mentions.test.ts shared/types.ts src/types/index.ts server/app.ts
git commit -m "feat: 工作目录文件树接口 + @文件引用解析（防路径逃逸）"
```

---

### Task 7: chat 执行（executeChatTurn + ChatTurnRunner + messages/stop）

**Files:**
- Modify: `server/claude/agent-manager.ts`（buildEnv 抽取 + executeChatTurn）
- Create: `server/chat/turn-runner.ts`
- Modify: `server/routes/chat.ts`（messages/stop + runner 接线）
- Modify: `server/app.ts`
- Create: `server/__tests__/chat-turn-runner.test.ts`
- Modify: `server/__tests__/chat-routes.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 `TokenUsage`；Task 5 `updateChatFields`；Task 6 `parseMentions/buildReferencedFilesBlock`。
- Produces: `ChatTurnConfig { sessionId: string; prompt: string; model?: string; resumeSessionId?: string; workspaces: Workspace[]; abortController?: AbortController; wsChannel: SessionChannel }`；`ChatTurnEvent = { type:'sdk_session'; sdkSessionId: string } | { type:'ai_stream'; content: string; done: boolean } | { type:'thinking_stream'; content: string; done: boolean } | { type:'tool_use'; toolName: string; input: Record<string, unknown> } | { type:'usage'; model: string; usage: TokenUsage } | { type:'turn_error'; error: string }`；`ClaudeAgentManager.executeChatTurn(config): AsyncGenerator<ChatTurnEvent>`；`ChatTurnRunner { isRunning(id): boolean; stop(id): boolean; startTurn(session: Session, content: string, defaultModel?: string): void }`；REST `POST /api/chat/:id/messages`（202）、`POST /api/chat/:id/stop`。

- [ ] **Step 1: agent-manager 重构 + executeChatTurn**

`server/claude/agent-manager.ts`：

1. 从 `buildSdkOptions` 抽出 env 构建为私有方法（`buildSdkOptions` 改为调用它）：

```ts
  /** SDK 运行环境：git-bash 探测 + 进程内 LLM 代理 + 隔离配置目录 */
  private buildEnv(): Record<string, string | undefined> {
    const env = { ...process.env } as Record<string, string | undefined>;
    if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
      const fs = require('fs');
      for (const candidate of GIT_BASH_CANDIDATES) {
        if (fs.existsSync(candidate)) {
          env.CLAUDE_CODE_GIT_BASH_PATH = candidate;
          break;
        }
      }
    }
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${appConfig.port}/_llm`;
    env.ANTHROPIC_AUTH_TOKEN = getInternalToken() || 'missing-internal-token';
    env.CLAUDE_CONFIG_DIR = path.join(process.cwd(), '.pipeline', 'claude-config');
    return env;
  }
```

（原 `buildSdkOptions` 开头的 env 构建段替换为 `const env = this.buildEnv();`。）

2. 新增类型与方法（放在 `execute` 之后）：

```ts
  /**
   * Claude 对话页：单轮执行。
   * persistSession + resume 实现多轮；includePartialMessages 实现
   * 文本/思考逐 token 流式。文本增量从 stream_event 取，assistant
   * 完整消息只用于提取工具调用与 model（避免内容重复推送）。
   */
  async *executeChatTurn(config: ChatTurnConfig): AsyncGenerator<ChatTurnEvent> {
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const sdkOptions: Record<string, unknown> = {
        cwd: config.workspaces[0]?.path || process.cwd(),
        canUseTool: this.createPermissionHook(config.wsChannel, config.sessionId),
        env: this.buildEnv(),
        persistSession: true,
        includePartialMessages: true,
        abortController: config.abortController ?? new AbortController(),
      };
      if (config.model) sdkOptions.model = config.model;
      if (config.resumeSessionId) sdkOptions.resume = config.resumeSessionId;

      const q = query({ prompt: config.prompt, options: sdkOptions });
      let lastModel: string | undefined;

      for await (const message of q as AsyncGenerator<Record<string, unknown>>) {
        const sdkSessionId = (message as { session_id?: string }).session_id;
        if (typeof sdkSessionId === 'string' && sdkSessionId) {
          yield { type: 'sdk_session', sdkSessionId };
        }

        if (message.type === 'stream_event') {
          const event = (message as { event?: any }).event;
          if (event?.type === 'content_block_delta') {
            if (event.delta?.type === 'thinking_delta') {
              yield { type: 'thinking_stream', content: event.delta.thinking || '', done: false };
            } else if (event.delta?.type === 'text_delta') {
              yield { type: 'ai_stream', content: event.delta.text || '', done: false };
            }
          }
          continue;
        }

        const msgData = this.extractMessageData(message);
        if (msgData.model) lastModel = msgData.model;

        if (message.type === 'assistant' || (message as { role?: string }).role === 'assistant') {
          for (const t of this.extractToolUses(message)) {
            yield { type: 'tool_use', toolName: t.name, input: t.input };
          }
        }

        if (message.type === 'result') {
          yield { type: 'thinking_stream', content: '', done: true };
          if (msgData.usage) {
            yield {
              type: 'usage',
              model: msgData.model || lastModel || 'unknown',
              usage: {
                inputTokens: msgData.usage.input_tokens ?? 0,
                outputTokens: msgData.usage.output_tokens ?? 0,
                cacheReadTokens: msgData.usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: msgData.usage.cache_creation_input_tokens ?? 0,
              },
            };
          }
          yield { type: 'ai_stream', content: '', done: true };
        }
      }
    } catch (err) {
      yield { type: 'turn_error', error: (err as Error).message };
    }
  }

  /** 提取一条 assistant 消息中的全部工具调用块 */
  private extractToolUses(message: Record<string, unknown>): Array<{ name: string; input: Record<string, unknown> }> {
    const msg = message as { content?: unknown; message?: { content?: unknown } };
    const content = msg.content || msg.message?.content;
    if (!Array.isArray(content)) return [];
    return (content as Array<Record<string, unknown>>)
      .filter((b): b is { type: 'tool_use'; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
      .map(b => ({ name: b.name, input: b.input }));
  }
```

3. 类型（与 AgentEvent 同区域导出）：

```ts
export interface ChatTurnConfig {
  sessionId: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  workspaces: Workspace[];
  abortController?: AbortController;
  wsChannel: SessionChannel;
}

export type ChatTurnEvent =
  | { type: 'sdk_session'; sdkSessionId: string }
  | { type: 'ai_stream'; content: string; done: boolean }
  | { type: 'thinking_stream'; content: string; done: boolean }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'usage'; model: string; usage: TokenUsage }
  | { type: 'turn_error'; error: string };
```

4. `extractMessageData` 的 usage 类型注意：result 分支的 `usage` 需含 `cache_read_input_tokens`/`cache_creation_input_tokens` 字段 —— Task 2 已把 usage 声明为 `Record<string, number>`，此处直接索引即可。

- [ ] **Step 2: ChatTurnRunner（先写失败测试）**

`server/__tests__/chat-turn-runner.test.ts`：

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createMemoryDb } from '../db/connection';
import { createTables } from '../db/schema';
import { DbHelper } from '../db/helper';
import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { ChatTurnRunner } from '../chat/turn-runner';
import type { ChatTurnEvent } from '../claude/agent-manager';
import { BUILTIN_CHAT_PIPELINE_ID } from '../../shared/types';
import type { Session } from '../../shared/types';

let dbHelper: DbHelper;
let sessionRepo: SessionRepository;
let usageRepo: UsageRepository;
const broadcasts: Array<{ type: string; data: any }> = [];
const wsChannel = { broadcastToSession: (_id: string, e: any) => broadcasts.push(e) } as never;

function makeSession(id: string, chatModel?: string): Session {
  const now = new Date().toISOString();
  const s: Session = {
    id, pipelineId: BUILTIN_CHAT_PIPELINE_ID,
    pipelineSnapshot: { id: BUILTIN_CHAT_PIPELINE_ID, name: '自由对话', description: '', steps: [], createdAt: now, updatedAt: now },
    name: '新对话', requirement: '', status: 'idle',
    workspaces: [{ name: 'ws', path: process.cwd(), type: 'unknown' }],
    currentStepIndex: 0, steps: [], chatModel,
    createdAt: now, updatedAt: now,
  };
  sessionRepo.create(s);
  return s;
}

function runnerWith(script: (cfg: any) => AsyncGenerator<ChatTurnEvent>): ChatTurnRunner {
  return new ChatTurnRunner({
    sessionRepo, usageRepo, wsChannel,
    agentManager: { executeChatTurn: (cfg) => script(cfg) },
  });
}

const flush = () => new Promise(r => setTimeout(r, 20));

beforeAll(async () => {
  const db = await createMemoryDb();
  createTables(db);
  dbHelper = new DbHelper(db);
  sessionRepo = new SessionRepository(dbHelper);
  usageRepo = new UsageRepository(dbHelper);
});

describe('ChatTurnRunner', () => {
  it('一轮完整对话：用户消息、流式、助手消息、usage、状态回 idle', async () => {
    const session = makeSession('r1');
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'sdk_session', sdkSessionId: 'sdk-xyz' };
      yield { type: 'ai_stream', content: '你', done: false };
      yield { type: 'ai_stream', content: '好', done: false };
      yield { type: 'usage', model: 'deepseek-chat', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '打个招呼', 'deepseek-chat');
    await flush();

    expect(runner.isRunning('r1')).toBe(false);
    const msgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r1' ORDER BY created_at",
    );
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]['content']).toBe('你好');
    const usageRow = dbHelper.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE session_id = 'r1'",
    );
    expect(usageRow!['model']).toBe('deepseek-chat');
    const loaded = sessionRepo.getById('r1')!;
    expect(loaded.chatSdkSessionId).toBe('sdk-xyz');
    expect(loaded.status).toBe('idle');
  });

  it('@引用注入 prompt 且越界引用被剔除', async () => {
    const session = makeSession('r2');
    let capturedPrompt = '';
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      capturedPrompt = cfg.prompt;
      yield { type: 'ai_stream', content: 'ok', done: false };
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '看 @package.json 和 @../escape.txt', 'm');
    await flush();
    expect(capturedPrompt).toContain('## Referenced Files');
    expect(capturedPrompt).toContain('package.json');
    expect(capturedPrompt).not.toContain('../escape.txt');
  });

  it('会话级模型优先于默认模型', async () => {
    const session = makeSession('r3', 'session-model');
    let capturedModel: string | undefined;
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      capturedModel = cfg.model;
      yield { type: 'ai_stream', content: '', done: true };
    });
    runner.startTurn(session, 'hi', 'default-model');
    await flush();
    expect(capturedModel).toBe('session-model');
  });

  it('stop 中断：保留已生成内容，状态回 idle', async () => {
    const session = makeSession('r4');
    const runner = runnerWith(async function* (cfg: any): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'ai_stream', content: '部分', done: false };
      await new Promise<void>((resolve) => {
        if (cfg.abortController.signal.aborted) return resolve();
        cfg.abortController.signal.addEventListener('abort', () => resolve());
      });
      yield { type: 'ai_stream', content: '', done: true };
    });

    runner.startTurn(session, '长任务', 'm');
    await flush();
    expect(runner.isRunning('r4')).toBe(true);
    expect(runner.stop('r4')).toBe(true);
    await flush();
    expect(runner.isRunning('r4')).toBe(false);
    const msgs = dbHelper.all<Record<string, unknown>>(
      "SELECT * FROM messages WHERE session_id = 'r4' AND role = 'assistant'",
    );
    expect(msgs[0]['content']).toBe('部分');
    expect(sessionRepo.getById('r4')!.status).toBe('idle');
  });

  it('turn_error → 状态 error', async () => {
    const session = makeSession('r5');
    const runner = runnerWith(async function* (): AsyncGenerator<ChatTurnEvent> {
      yield { type: 'turn_error', error: '上游 500' };
    });
    runner.startTurn(session, 'hi', 'm');
    await flush();
    expect(sessionRepo.getById('r5')!.status).toBe('error');
  });
});
```

Run → FAIL（模块不存在）。创建 `server/chat/turn-runner.ts`：

```ts
import { SessionRepository } from '../db/repositories/sessions';
import { UsageRepository } from '../db/repositories/usage';
import { parseMentions, buildReferencedFilesBlock } from './mentions';
import type { ChatTurnConfig, ChatTurnEvent } from '../claude/agent-manager';
import type { Session } from '../../shared/types';

export interface ChatAgentLike {
  executeChatTurn(config: ChatTurnConfig): AsyncGenerator<ChatTurnEvent>;
}

export interface ChatRunnerDeps {
  sessionRepo: SessionRepository;
  usageRepo: UsageRepository;
  wsChannel?: { broadcastToSession: (sessionId: string, event: unknown) => void };
  agentManager: ChatAgentLike;
}

/**
 * Claude 对话轮次执行器：解析 @引用 → 写用户消息 → 流式转发 WS →
 * 落库助手消息与 usage → 状态机 running→idle/error。
 */
export class ChatTurnRunner {
  private controllers = new Map<string, AbortController>();

  constructor(private deps: ChatRunnerDeps) {}

  isRunning(sessionId: string): boolean {
    return this.controllers.has(sessionId);
  }

  /** 中断当前轮；返回是否确有运行中的轮被中断 */
  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 发起一轮对话（后台执行，立即返回） */
  startTurn(session: Session, content: string, defaultModel?: string): void {
    if (this.controllers.has(session.id)) return;

    const root = session.workspaces[0]?.path || process.cwd();
    const mentions = parseMentions(content, root);
    const prompt = [content, buildReferencedFilesBlock(mentions.files)].filter(Boolean).join('\n\n');

    this.deps.sessionRepo.addMessage(session.id, null, 'user', content);
    this.deps.sessionRepo.updateStatus(session.id, 'running');
    this.deps.wsChannel?.broadcastToSession(session.id, {
      type: 'status_change', data: { status: 'running', currentStepIndex: 0 },
    });

    const controller = new AbortController();
    this.controllers.set(session.id, controller);

    const accumulated = { content: '', thinking: '' };

    (async () => {
      let turnError: string | null = null;
      try {
        for await (const event of this.deps.agentManager.executeChatTurn({
          sessionId: session.id,
          prompt,
          model: session.chatModel || defaultModel,
          resumeSessionId: session.chatSdkSessionId,
          workspaces: session.workspaces,
          abortController: controller,
          wsChannel: this.deps.wsChannel as never,
        })) {
          switch (event.type) {
            case 'sdk_session':
              this.deps.sessionRepo.updateChatFields(session.id, { chatSdkSessionId: event.sdkSessionId });
              break;
            case 'thinking_stream':
              if (!event.done) accumulated.thinking += event.content;
              this.deps.wsChannel?.broadcastToSession(session.id, {
                type: 'thinking_delta', data: { content: event.content, done: event.done },
              });
              break;
            case 'ai_stream':
              if (!event.done) accumulated.content += event.content;
              this.deps.wsChannel?.broadcastToSession(session.id, {
                type: 'ai_message', data: { content: event.content, done: event.done },
              });
              break;
            case 'tool_use':
              this.deps.wsChannel?.broadcastToSession(session.id, {
                type: 'tool_use', data: { toolName: event.toolName, input: event.input },
              });
              break;
            case 'usage':
              this.deps.usageRepo.add({
                sessionId: session.id,
                model: event.model,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                cacheReadTokens: event.usage.cacheReadTokens,
                cacheCreationTokens: event.usage.cacheCreationTokens,
              });
              break;
            case 'turn_error':
              turnError = event.error;
              break;
          }
        }
      } catch (err) {
        turnError = (err as Error).message;
      } finally {
        this.controllers.delete(session.id);
        if (accumulated.content || accumulated.thinking) {
          this.deps.sessionRepo.addMessage(
            session.id, null, 'assistant',
            accumulated.content, accumulated.thinking || undefined,
          );
        }
        const aborted = controller.signal.aborted;
        const status = turnError && !aborted ? 'error' : 'idle';
        this.deps.sessionRepo.updateStatus(session.id, status);
        this.deps.wsChannel?.broadcastToSession(session.id, {
          type: 'status_change', data: { status, currentStepIndex: 0 },
        });
      }
    })();
  }
}
```

- [ ] **Step 3: 路由接线（先追加失败用例）**

在 `server/__tests__/chat-routes.test.ts` 追加：

```ts
import { ChatTurnRunner } from '../chat/turn-runner';

describe('chat messages/stop', () => {
  it('发消息 202；生成中再次发送 409；stop 后恢复', async () => {
    const created = await req('POST', '/api/chat/sessions', { workspaces: [{ name: 'w', path: process.cwd(), type: 'unknown' }] });
    const id = created.body.data.id;

    // 挂起的伪 agentManager
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const hangingRunner = new ChatTurnRunner({
      sessionRepo: new (require('../db/repositories/sessions').SessionRepository)(dbHelper),
      usageRepo: new (require('../db/repositories/usage').UsageRepository)(dbHelper),
      agentManager: {
        async *executeChatTurn(cfg: any): AsyncGenerator<any> {
          yield { type: 'ai_stream', content: 'x', done: false };
          await gate;
          yield { type: 'ai_stream', content: '', done: true };
        },
      },
    });

    // 无生效供应商 → 400
    const blocked = await fetch(`${baseUrl}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(blocked.status).toBe(400);

    // 挂 providerRepo 依赖重新挂载一个带 runner 的实例（直接以第二个路由实例测 202/409/stop）
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/chat', createChatRoutes({
      dbHelper,
      runner: hangingRunner,
      providerRepo: { getActive: () => ({ model: 'm' }) } as never,
    }));
    const server2 = http.createServer(app2);
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const base2 = `http://127.0.0.1:${(server2.address() as any).port}`;

    const send = await fetch(`${base2}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(send.status).toBe(202);
    await new Promise(r => setTimeout(r, 30));

    const again = await fetch(`${base2}/api/chat/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'again' }),
    });
    expect(again.status).toBe(409);

    const stop = await fetch(`${base2}/api/chat/${id}/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    release();
    await new Promise(r => setTimeout(r, 30));
    server2.close();
  });

  it('流水线会话发消息 404', async () => {
    // 直接对不存在的 id
    const res = await fetch(`${baseUrl}/api/chat/missing-id/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});
```

注意：测试文件顶部需要补 `import express from 'express'`（已有）与 SessionRepository/UsageRepository 的正常 import（把 `require(...)` 改为顶部 import）。

`server/routes/chat.ts` 变更：
1. deps 接口扩为本文档开头声明的完整 `ChatRouteDeps`（含 wsChannel/agentManager/runner）。
2. `createChatRoutes` 内、`isChatSession` 之后构造 runner：

```ts
  const runner = deps.runner ?? new ChatTurnRunner({
    sessionRepo,
    usageRepo: new UsageRepository(deps.dbHelper),
    wsChannel: deps.wsChannel,
    agentManager: deps.agentManager ?? new ClaudeAgentManager(),
  });
```

3. 追加两条路由（放在 DELETE 之后）：

```ts
  // 发送一轮消息（后台执行，流式经 WS 推送）
  router.post('/:id/messages', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const { content } = req.body || {};
      if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });
      if (!requireActiveProvider(res)) return;
      if (runner.isRunning(session.id)) {
        return res.status(409).json({ success: false, error: '当前回复生成中，请稍候或先停止' });
      }
      const defaultModel = deps.providerRepo?.getActive()?.model;
      runner.startTurn(session, content.trim(), defaultModel);
      res.status(202).json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  // 停止当前轮
  router.post('/:id/stop', (req: Request, res: Response) => {
    try {
      const session = sessionRepo.getById(req.params.id);
      if (!isChatSession(session)) return res.status(404).json({ success: false, error: '对话不存在' });
      const stopped = runner.stop(session.id);
      res.json({ success: true, data: { stopped } });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });
```

imports 增加：`import { ChatTurnRunner } from '../chat/turn-runner';`、`import { ClaudeAgentManager } from '../claude/agent-manager';`、`import { UsageRepository } from '../db/repositories/usage';`、`import type { SessionChannel } from '../../shared/types';`（SessionChannel 若不在 shared 中则从 `'../ws/session-channel'` 导入类型 —— 以现有 sessions.ts 的导入方式为准：`import { SessionChannel } from '../ws/session-channel';`）。

`server/app.ts` 的 chat 挂载改为：

```ts
    app.use('/api/chat', createChatRoutes({
      dbHelper: options.dbHelper,
      providerRepo,
      wsChannel: options.wsChannel,
    }));
```

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add server/claude/agent-manager.ts server/chat/turn-runner.ts server/routes/chat.ts server/app.ts server/__tests__/chat-turn-runner.test.ts server/__tests__/chat-routes.test.ts
git commit -m "feat: chat 多轮执行（executeChatTurn resume + ChatTurnRunner + messages/stop API）"
```

---

### Task 8: diff 审批（行级 diff 工具 + canUseTool 附载 + PermissionModal）

**Files:**
- Create: `server/utils/diff.ts`
- Create: `server/utils/tool-diff.ts`
- Create: `server/__tests__/diff.test.ts`
- Create: `server/__tests__/permission-diff.test.ts`
- Modify: `shared/types.ts`（DiffLine/DiffInfo + PermissionRequest.diff）
- Modify: `src/types/index.ts`
- Modify: `server/claude/agent-manager.ts`（权限钩子附载 diff）
- Modify: `src/components/PermissionModal.tsx`

**Interfaces:**
- Consumes: Task 2 无关；`extractMessageData` 无关。
- Produces: shared `DiffLine { type: 'ctx' | 'add' | 'del'; text: string }`、`DiffInfo { path: string; oldContent: string; newContent: string; diffLines: DiffLine[] }`、`PermissionRequest.diff?: DiffInfo`；server `lineDiff(oldText, newText): DiffLine[]`、`buildToolDiff(toolName, input): ToolDiffPreview | null`。

- [ ] **Step 1: shared 类型**

`shared/types.ts`（权限确认区）追加：

```ts
export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

export interface DiffInfo {
  path: string;
  oldContent: string;
  newContent: string;
  diffLines: DiffLine[];
}
```

`PermissionRequest` 接口追加字段：`diff?: DiffInfo;   // Edit/Write 类工具的变更预览`。

`src/types/index.ts` type 列表加 `DiffLine, DiffInfo`。

- [ ] **Step 2: 写失败测试**

`server/__tests__/diff.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { lineDiff } from '../utils/diff';

describe('lineDiff', () => {
  it('相同内容全 ctx', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'ctx', text: 'a' }, { type: 'ctx', text: 'b' },
    ]);
  });

  it('标记新增与删除行', () => {
    const d = lineDiff('a\nb\nc', 'a\nX\nc');
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'X' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('全新文件全 add', () => {
    expect(lineDiff('', 'l1\nl2')).toEqual([
      { type: 'add', text: 'l1' }, { type: 'add', text: 'l2' },
    ]);
  });

  it('超大文件回退为整删整加', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(big, big + '\nextra');
    // 3000 del + 3001 add = 6001 行，且包含 extra
    expect(d.filter(x => x.type === 'add').map(x => x.text)).toContain('extra');
  });
});
```

`server/__tests__/permission-diff.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildToolDiff } from '../utils/tool-diff';

let dir: string;
let file: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-'));
  file = path.join(dir, 'code.ts');
  fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildToolDiff', () => {
  it('Edit：按 old/new string 构造应用后全文', () => {
    const d = buildToolDiff('Edit', {
      file_path: file,
      old_string: 'const a = 1;',
      new_string: 'const a = 42;',
    });
    expect(d!.newContent).toBe('const a = 42;\nconst b = 2;\n');
    expect(d!.diffLines.some(l => l.type === 'add' && l.text.includes('42'))).toBe(true);
    expect(d!.diffLines.some(l => l.type === 'del' && l.text.includes('= 1;'))).toBe(true);
  });

  it('Edit replace_all 替换全部出现', () => {
    const f2 = path.join(dir, 'all.ts');
    fs.writeFileSync(f2, 'x\nx\n');
    const d = buildToolDiff('Edit', { file_path: f2, old_string: 'x', new_string: 'y', replace_all: true });
    expect(d!.newContent).toBe('y\ny\n');
  });

  it('Write：整个文件替换', () => {
    const d = buildToolDiff('Write', { file_path: file, content: 'totally new' });
    expect(d!.oldContent).toContain('const a = 42;' === '' ? '' : 'const');
    expect(d!.newContent).toBe('totally new');
  });

  it('新文件（读不到原内容）全绿 add', () => {
    const d = buildToolDiff('Write', { file_path: path.join(dir, 'new.ts'), content: 'hi' });
    expect(d!.oldContent).toBe('');
    expect(d!.diffLines.every(l => l.type === 'add' || l.type === 'ctx')).toBe(true);
  });

  it('非编辑类工具返回 null', () => {
    expect(buildToolDiff('Bash', { command: 'ls' })).toBeNull();
  });
});
```

Run both → FAIL。

- [ ] **Step 3: 实现 diff 工具**

`server/utils/diff.ts`：

```ts
export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

/**
 * 行级 LCS diff。超大输入（n*m > 4_000_000）退化为整删整加，避免 O(n*m) 内存。
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const n = a.length, m = b.length;

  if (n * m > 4_000_000) {
    return [
      ...a.map(text => ({ type: 'del' as const, text })),
      ...b.map(text => ({ type: 'add' as const, text })),
    ];
  }

  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j] }); j++; }
  return out;
}
```

`server/utils/tool-diff.ts`：

```ts
import fs from 'fs';
import { lineDiff } from './diff';
import type { DiffInfo } from '../../shared/types';

/**
 * 为 Edit/Write/NotebookEdit 构造"应用后全文"预览与行级 diff。
 * 读不到原文件（新建）按空字符串处理，diff 全为 add。
 */
export function buildToolDiff(toolName: string, input: Record<string, unknown>): DiffInfo | null {
  const p = (input.file_path || input.notebook_path) as string | undefined;
  if (!p) return null;

  let oldContent = '';
  try { oldContent = fs.readFileSync(p, 'utf-8'); } catch { oldContent = ''; }

  let newContent = oldContent;
  if (toolName === 'Edit') {
    const oldStr = input.old_string as string | undefined;
    const newStr = (input.new_string as string) ?? '';
    if (typeof oldStr === 'string' && oldStr.length > 0) {
      newContent = input.replace_all
        ? oldContent.split(oldStr).join(newStr)
        : oldContent.replace(oldStr, newStr);
    }
  } else if (toolName === 'Write') {
    newContent = (input.content as string) ?? '';
  } else if (toolName === 'NotebookEdit') {
    newContent = (input.new_source as string) ?? oldContent;
  } else {
    return null;
  }

  return { path: p, oldContent, newContent, diffLines: lineDiff(oldContent, newContent) };
}
```

- [ ] **Step 4: 权限钩子附载 diff（先写失败测试）**

在 `server/__tests__/permission-diff.test.ts` 追加：

```ts
import { ClaudeAgentManager } from '../claude/agent-manager';

describe('canUseTool 附载 diff', () => {
  it('Edit 权限请求携带 diff 载荷', async () => {
    const sent: any[] = [];
    const wsChannel = { broadcastToSession: (_id: string, e: any) => sent.push(e) } as never;
    const manager = new ClaudeAgentManager();
    // @ts-expect-error 访问私有方法仅为测试权限钩子装配
    const hook = manager.createPermissionHook(wsChannel, 'sess-1');

    const promise = hook('Edit', { file_path: file, old_string: 'const a = 42;', new_string: 'const a = 1;' }, {
      signal: new AbortController().signal, toolUseID: 't1',
    });
    // 不等待用户决策：断言广播后直接 deny 结束
    const广播 = sent.find(e => e.type === 'permission_request');
    expect(广播).toBeDefined();
    expect(广播.data.diff).toBeDefined();
    expect(广播.data.diff.path).toBe(file);
    expect(广播.data.diff.diffLines.length).toBeGreaterThan(0);
    // 清理：拒绝该请求以结束挂起的 promise
    const { resolvePermission } = await import('../ws/permission-store');
    resolvePermission(广播.data.id, 'deny');
    await promise;
  });
});
```

（注意：变量名与注释中不得使用非代码字符 —— 上面 `广播` 占位在实际写入时改为 `broadcastEvent`。）

修正后的该用例代码：

```ts
describe('canUseTool 附载 diff', () => {
  it('Edit 权限请求携带 diff 载荷', async () => {
    const sent: any[] = [];
    const wsChannel = { broadcastToSession: (_id: string, e: any) => sent.push(e) } as never;
    const manager = new ClaudeAgentManager();
    const hook = (manager as unknown as {
      createPermissionHook: (ws: never, sid: string) => (
        toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;
    }).createPermissionHook(wsChannel as never, 'sess-diff-1');

    const pending = hook('Edit', { file_path: file, old_string: 'const a = 42;', new_string: 'const a = 1;' }, {
      signal: new AbortController().signal, toolUseID: 't1',
    });

    const broadcastEvent = sent.find(e => e.type === 'permission_request');
    expect(broadcastEvent).toBeDefined();
    expect(broadcastEvent.data.diff).toBeDefined();
    expect(broadcastEvent.data.diff.path).toBe(file);
    expect(broadcastEvent.data.diff.diffLines.length).toBeGreaterThan(0);

    const { resolvePermission } = await import('../ws/permission-store');
    resolvePermission(broadcastEvent.data.id, 'deny');
    await pending;
  });
});
```

Run → FAIL（diff 字段缺失）。

实现：`server/claude/agent-manager.ts` 权限钩子内，`wsChannel.broadcastToSession(...)` 之前加：

```ts
      const diff = buildToolDiff(toolName, input);
```

data 对象末尾追加 `...(diff ? { diff } : {})`（文件顶部导入 `import { buildToolDiff } from '../utils/tool-diff';`）。

- [ ] **Step 5: PermissionModal diff 视图**

`src/components/PermissionModal.tsx` 修改：

```tsx
import { Modal, Typography, Space, Tag, Button, Descriptions, theme } from 'antd';
import { CheckOutlined, CloseOutlined, SafetyOutlined, FileTextOutlined } from '@ant-design/icons';
import type { PermissionRequest } from '../types';

const RISK_COLORS: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '⚠️ 高风险' };
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

interface Props {
  request: PermissionRequest | null;
  onAllow: () => void;
  onDeny: () => void;
  onWhitelist: () => void;
}

export default function PermissionModal({ request, onAllow, onDeny, onWhitelist }: Props) {
  const { token } = theme.useToken();
  if (!request) return null;

  const isEdit = EDIT_TOOLS.includes(request.toolName);

  return (
    <Modal
      title={
        <Space>
          <SafetyOutlined style={{ color: '#faad14' }} />
          {isEdit ? '编辑文件确认' : '权限确认请求'}
        </Space>
      }
      open={!!request}
      onCancel={onDeny}
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button danger icon={<CloseOutlined />} onClick={onDeny}>拒绝</Button>
          <Button icon={<SafetyOutlined />} onClick={onWhitelist}>本次会话始终允许</Button>
          <Button type="primary" icon={<CheckOutlined />} onClick={onAllow}>允许一次</Button>
        </Space>
      }
      width={request.diff ? 760 : 580}
    >
      <Descriptions column={1} size="small">
        <Descriptions.Item label="工具">
          <Space>
            <Tag color="blue">{request.toolName}</Tag>
            {isEdit && <Tag icon={<FileTextOutlined />} color="orange">{request.diff?.path}</Tag>}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="风险等级">
          <Tag color={RISK_COLORS[request.risk]}>{RISK_LABELS[request.risk]}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="详情">
          <Typography.Text>{request.message}</Typography.Text>
        </Descriptions.Item>
        {request.diff && (
          <Descriptions.Item label="变更预览">
            <div style={{
              maxHeight: 280, overflow: 'auto',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 4, fontFamily: 'Consolas, Monaco, monospace', fontSize: 12, lineHeight: 1.5,
            }}>
              {request.diff.diffLines.map((l, i) => (
                <div
                  key={i}
                  style={{
                    padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    background: l.type === 'add' ? '#e6ffec' : l.type === 'del' ? '#ffebe9' : undefined,
                    color: l.type === 'add' ? '#1a7f37' : l.type === 'del' ? '#cf222e' : token.colorText,
                  }}
                >
                  {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}
                </div>
              ))}
            </div>
          </Descriptions.Item>
        )}
        {!request.diff && Object.keys(request.toolInput).length > 0 && (
          <Descriptions.Item label="参数">
            <Typography.Paragraph code style={{ maxHeight: 120, overflow: 'auto', fontSize: 12, margin: 0 }}>
              {JSON.stringify(request.toolInput, null, 2)}
            </Typography.Paragraph>
          </Descriptions.Item>
        )}
      </Descriptions>
    </Modal>
  );
}
```

- [ ] **Step 6: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add server/utils/diff.ts server/utils/tool-diff.ts server/__tests__/diff.test.ts server/__tests__/permission-diff.test.ts shared/types.ts src/types/index.ts server/claude/agent-manager.ts src/components/PermissionModal.tsx
git commit -m "feat: Edit/Write diff 审批（行级 diff + 权限弹窗变更预览）"
```

---

### Task 9: 前端共享组件抽取（ThinkingSection / ChatMessages / useLiveMessages）

**Files:**
- Create: `src/components/ThinkingSection.tsx`
- Create: `src/components/ChatMessages.tsx`
- Create: `src/hooks/useLiveMessages.ts`
- Create: `src/components/__tests__/ChatMessages.test.tsx`
- Modify: `src/pages/SessionDetail.tsx`（改用共享组件，逻辑不变）

**Interfaces:**
- Produces: `ThinkingSection({ thinking: string; streaming: boolean })`；`ChatMessages({ messages: Msg[]; thinkingPendingIds: Set<string>; height?: number | string })`（自带滚动到底）；`useLiveMessages(sessionId): { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected, on, send }` —— 封装 `ai_message`/`thinking_delta`/`tool_use`/`permission_request` 四类 WS 事件。

- [ ] **Step 1: 写失败测试**

`src/components/__tests__/ChatMessages.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatMessages from '../ChatMessages';
import type { Message as Msg } from '../../types';

const msgs: Msg[] = [
  { id: '1', sessionId: 's', role: 'user', content: '你好', createdAt: '2026-01-01T00:00:00Z' },
  { id: '2', sessionId: 's', role: 'assistant', content: '有什么可以帮你？', createdAt: '2026-01-01T00:00:01Z' },
];

describe('ChatMessages', () => {
  it('渲染用户与助手气泡', () => {
    render(<ChatMessages messages={msgs} thinkingPendingIds={new Set()} />);
    expect(screen.getByText('你好')).toBeDefined();
    expect(screen.getByText('有什么可以帮你？')).toBeDefined();
    expect(screen.getByText(/👤 你/)).toBeDefined();
  });

  it('带 thinking 的助手消息渲染思考区', () => {
    const withThinking: Msg[] = [{ ...msgs[1], thinking: '思考内容' }];
    render(<ChatMessages messages={withThinking} thinkingPendingIds={new Set(['2'])} />);
    expect(screen.getByText(/思考过程/)).toBeDefined();
  });

  it('空消息显示占位', () => {
    render(<ChatMessages messages={[]} thinkingPendingIds={new Set()} />);
    expect(screen.getByText('暂无消息')).toBeDefined();
  });
});
```

Run → FAIL。

- [ ] **Step 2: 实现三个共享单元**

`src/components/ThinkingSection.tsx`（从 SessionDetail 抽出并 token 化）：

```tsx
import { useEffect, useState } from 'react';
import { theme as antdTheme } from 'antd';

interface Props {
  thinking: string;
  streaming: boolean;
}

export default function ThinkingSection({ thinking, streaming }: Props) {
  const { token } = antdTheme.useToken();
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    if (streaming) {
      setCollapsed(false);
    } else {
      const timer = setTimeout(() => setCollapsed(true), 2000);
      return () => clearTimeout(timer);
    }
  }, [streaming]);

  return (
    <div style={{
      marginTop: 6, marginBottom: 8,
      background: token.colorFillSecondary,
      border: `1px solid ${token.colorBorder}`,
      borderRadius: 6, padding: '6px 10px', fontSize: 12, lineHeight: 1.5,
    }}>
      <div
        onClick={() => setCollapsed(!collapsed)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none', color: token.colorTextSecondary }}
      >
        <span>🧠</span>
        <span style={{ fontWeight: 500, fontSize: 11 }}>
          思考过程
          {streaming && <span style={{ marginLeft: 4, color: token.colorTextQuaternary, fontSize: 10 }}>(思考中...)</span>}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: token.colorTextQuaternary }}>
          {collapsed ? '▶ 展开' : '▼ 收起'}
        </span>
      </div>
      {!collapsed && (
        <div style={{
          marginTop: 6, padding: '6px 8px',
          background: token.colorFillTertiary, borderRadius: 4,
          color: token.colorTextSecondary, fontStyle: 'italic',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: streaming ? 300 : 2000,
          overflowY: streaming ? 'auto' : 'visible', fontSize: 11,
        }}>
          {thinking}
          {streaming && <span className="thinking-cursor">|</span>}
        </div>
      )}
    </div>
  );
}
```

`src/components/ChatMessages.tsx`：

```tsx
import { useEffect, useRef } from 'react';
import { Typography, theme as antdTheme } from 'antd';
import type { Message as Msg } from '../types';
import ThinkingSection from './ThinkingSection';

interface Props {
  messages: Msg[];
  /** thinking 仍在流式接收的消息 id 集合 */
  thinkingPendingIds: Set<string>;
  height?: number | string;
}

export default function ChatMessages({ messages, thinkingPendingIds, height = 450 }: Props) {
  const { token } = antdTheme.useToken();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ height, overflow: 'auto', padding: 16, background: token.colorBgLayout }}>
      {messages.length === 0 && <Typography.Text type="secondary">暂无消息</Typography.Text>}
      {messages.map(m => (
        <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
          <div style={{
            maxWidth: '85%', padding: '8px 12px', borderRadius: 8,
            background: m.role === 'user' ? token.colorPrimary
              : m.role === 'system' ? token.colorFillSecondary : token.colorFillTertiary,
            color: m.role === 'system' ? token.colorWarning : token.colorText,
            border: m.role === 'system' ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}>
            <Typography.Text style={{ color: token.colorTextSecondary, fontSize: 10, display: 'block' }}>
              {m.role === 'user' ? '👤 你' : m.role === 'system' ? '⚡ 系统' : '🤖 AI'}
              {' · '}{new Date(m.createdAt).toLocaleTimeString()}
            </Typography.Text>
            {m.role === 'assistant' && m.thinking && (
              <ThinkingSection thinking={m.thinking} streaming={thinkingPendingIds.has(m.id)} />
            )}
            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
              {m.content}
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
```

`src/hooks/useLiveMessages.ts`：

```ts
import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import type { Message as Msg, PermissionRequest } from '../types';

/**
 * 会话实时消息流：封装 ai_message / thinking_delta / tool_use /
 * permission_request 的 WS 处理与消息累积。流水线会话详情与 Claude 对话页共用。
 * 空内容的 ai_message（done 信号）不产生气泡，UI 刷新由 status_change 驱动。
 */
export function useLiveMessages(sessionId: string | undefined) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const thinkingDoneRef = useRef<Set<string>>(new Set());
  const { connected, on, send } = useWebSocket(sessionId);

  // 会话切换：清空状态
  useEffect(() => {
    thinkingDoneRef.current = new Set();
    setMessages([]);
    setPermissionRequest(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubs = [
      on('ai_message', (data) => {
        if (!data.content) return; // 空内容仅是结束信号
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !data.done) {
            return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
          }
          return [...prev, {
            id: `ai-${Date.now()}`, sessionId: sessionId!, stepId: data.stepId,
            role: 'assistant', content: data.content, createdAt: new Date().toISOString(),
          }];
        });
      }),
      on('thinking_delta', (data) => {
        const { content, done } = data;
        if (!content && done) return;
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !thinkingDoneRef.current.has(last.id)) {
            const updatedThinking = (last.thinking || '') + content;
            if (done) thinkingDoneRef.current.add(last.id);
            return [...prev.slice(0, -1), { ...last, thinking: updatedThinking }];
          }
          const newMsg: Msg = {
            id: `ai-${Date.now()}`, sessionId: sessionId!, role: 'assistant',
            content: '', thinking: content, createdAt: new Date().toISOString(),
          };
          if (done) thinkingDoneRef.current.add(newMsg.id);
          return [...prev, newMsg];
        });
      }),
      on('tool_use', (data) => {
        setMessages(prev => [...prev, {
          id: `tool-${Date.now()}`, sessionId: sessionId!, role: 'system',
          content: `⚡ Tool: ${data.toolName} - ${JSON.stringify(data.input).substring(0, 100)}`,
          createdAt: new Date().toISOString(),
        }]);
      }),
      on('permission_request', (data) => {
        setPermissionRequest(data);
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [on, sessionId]);

  return { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected, on, send };
}
```

- [ ] **Step 3: SessionDetail 改用共享组件**

`src/pages/SessionDetail.tsx`（保持行为不变，只替换实现）：
1. 删除文件内 `ThinkingSection` 函数、注入的 thinking-blink `<style>`（移入共享组件所属：在 `ThinkingSection.tsx` 中保留原有 keyframes 注入 —— 在该组件文件顶部加同样的 `useEffect` 注入逻辑，模块级单例）。
2. `messages`/`permissionRequest` 状态与对应 WS 监听改用 `useLiveMessages(id)`；`load()` 成功后 `setMessages(msgs)` 并为带 thinking 的历史助手消息填充 `thinkingDoneRef.current`。
3. 保留 `status_change`、`step_complete` 监听（`step_complete` 仍调 `load()`）。
4. 聊天区主体替换为：

```tsx
<ChatMessages
  messages={messages}
  thinkingPendingIds={new Set(
    messages.filter(m => m.role === 'assistant' && m.thinking && !thinkingDoneRef.current.has(m.id)).map(m => m.id)
  )}
  height={450}
/>
```

5. 其余（步骤进度、操作按钮、输入框、PermissionModal）不动；`chatEndRef`/手写气泡渲染代码删除。

- [ ] **Step 4: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit` → 全绿。

```bash
git add src/components/ThinkingSection.tsx src/components/ChatMessages.tsx src/hooks/useLiveMessages.ts src/components/__tests__/ChatMessages.test.tsx src/pages/SessionDetail.tsx
git commit -m "refactor: 抽取 ThinkingSection/ChatMessages/useLiveMessages 共享组件"
```

---

### Task 10: 对话页前端（/chat 列表 + /chat/:id 对话）

**Files:**
- Create: `src/api/chat.ts`
- Create: `src/pages/ChatList.tsx`
- Create: `src/pages/ChatSession.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Layout.tsx`（菜单加「Claude 对话」）

**Interfaces:**
- Consumes: Task 5/7 的 REST（`POST /api/chat/sessions`、`GET /api/chat/sessions`、`PUT /api/chat/:id/model`、`DELETE /api/chat/:id`、`POST /api/chat/:id/messages`、`POST /api/chat/:id/stop`）、Task 6 `GET /api/fs/tree`、既有 `GET /api/sessions/:id`、`GET /api/sessions/:id/messages`、`GET /api/providers`。

- [ ] **Step 1: chat API client**

`src/api/chat.ts`：

```ts
import { api } from './client';
import type { Session, FsNode } from '../types';

export const chatApi = {
  list: () => api.get<Session[]>('/chat/sessions'),
  create: (data: { workspaces: { name: string; path: string; type: string }[]; model?: string }) =>
    api.post<Session>('/chat/sessions', data),
  remove: (id: string) => api.delete<void>(`/chat/${id}`),
  setModel: (id: string, model?: string) => api.put<Session>(`/chat/${id}/model`, { model }),
  sendMessage: (id: string, content: string) => api.post<void>(`/chat/${id}/messages`, { content }),
  stop: (id: string) => api.post<void>(`/chat/${id}/stop`),
};

export const fsApi = {
  tree: (root: string) => api.get<FsNode>(`/fs/tree?root=${encodeURIComponent(root)}`),
};
```

- [ ] **Step 2: ChatList 页面**

`src/pages/ChatList.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Typography, Card, List, Button, Modal, Input, Popconfirm, message, Tag, Space, Empty } from 'antd';
import { PlusOutlined, DeleteOutlined, CommentOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { chatApi } from '../api/chat';
import type { Session } from '../types';

const STATUS_TAGS: Record<string, { color: string; label: string }> = {
  idle: { color: 'default', label: '待输入' },
  running: { color: 'processing', label: '生成中' },
  error: { color: 'error', label: '异常' },
};

export default function ChatList() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSessions(await chatApi.list()); }
    catch { message.error('加载对话列表失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const path = workspacePath.trim();
    if (!path) { message.warning('请填写工作目录'); return; }
    setCreating(true);
    try {
      const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工作目录';
      const s = await chatApi.create({ workspaces: [{ name, path, type: 'unknown' }] });
      message.success('对话已创建');
      setModalOpen(false);
      setWorkspacePath('');
      navigate(`/chat/${s.id}`);
    } catch (err: any) {
      message.error(err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await chatApi.remove(id);
      message.success('已删除');
      load();
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>Claude 对话</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新建对话</Button>
      </div>

      <Card>
        <List
          loading={loading}
          dataSource={sessions}
          locale={{ emptyText: <Empty description="还没有对话，点右上角新建一个" /> }}
          renderItem={(s) => {
            const st = STATUS_TAGS[s.status] || STATUS_TAGS.idle;
            return (
              <List.Item
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/chat/${s.id}`)}
                actions={[
                  <Popconfirm key="del" title="删除该对话及其全部消息？" onConfirm={(e) => { e?.stopPropagation(); handleDelete(s.id); }} onCancel={(e) => e?.stopPropagation()}>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>,
                  <Button key="go" size="small" type="link" icon={<ArrowRightOutlined />} onClick={(e) => { e.stopPropagation(); navigate(`/chat/${s.id}`); }} />,
                ]}
              >
                <List.Item.Meta
                  avatar={<CommentOutlined style={{ fontSize: 20, marginTop: 4 }} />}
                  title={<Space><span>{s.name}</span><Tag color={st.color}>{st.label}</Tag></Space>}
                  description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.workspaces[0]?.path}</Typography.Text>}
                />
              </List.Item>
            );
          }}
        />
      </Card>

      <Modal
        title="新建 Claude 对话"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
      >
        <Input
          placeholder="工作目录绝对路径，如 D:\\develop\\workspace\\my-app"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          onPressEnter={handleCreate}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Claude 将在该目录内读写文件；模型可在对话页随时切换。
        </Typography.Text>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 3: ChatSession 页面**

`src/pages/ChatSession.tsx`：

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Typography, Card, Button, message, Badge, Tag, Space, AutoComplete, Mentions,
  Popconfirm, List, Empty,
} from 'antd';
import {
  SendOutlined, ArrowLeftOutlined, PlusOutlined, StopOutlined,
  CommentOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { chatApi, fsApi } from '../api/chat';
import { sessionApi } from '../api/sessions';
import { providerApi } from '../api/providers';
import { useLiveMessages } from '../hooks/useLiveMessages';
import ChatMessages from '../components/ChatMessages';
import PermissionModal from '../components/PermissionModal';
import type { Session, FsNode } from '../types';

/** 文件树扁平化为 @引用候选（相对路径，上限 2000） */
function flattenOptions(node: FsNode, root: string, out: { value: string }[] = []): { value: string }[] {
  if (out.length >= 2000) return out;
  const rel = node.path === root ? '' : node.path.slice(root.length + 1).replace(/\\/g, '/');
  if (node.type === 'file' && rel) out.push({ value: rel });
  for (const c of node.children || []) flattenOptions(c, root, out);
  return out;
}

export default function ChatSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [chatList, setChatList] = useState<Session[]>([]);
  const [input, setInput] = useState('');
  const [fileOptions, setFileOptions] = useState<{ value: string }[]>([]);
  const [modelOptions, setModelOptions] = useState<{ value: string }[]>([]);
  const [model, setModel] = useState<string>('');
  const [sending, setSending] = useState(false);

  const { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected } = useLiveMessages(id);

  const running = session?.status === 'running';

  const loadSession = useCallback(async () => {
    if (!id) return;
    try {
      const s = await sessionApi.get(id);
      setSession(s);
      setModel(s.chatModel || '');
    } catch { message.error('加载对话失败'); }
  }, [id]);

  const loadMessages = useCallback(async () => {
    if (!id) return;
    try {
      const msgs = await sessionApi.getMessages(id);
      setMessages(msgs);
      thinkingDoneRef.current = new Set(
        msgs.filter(m => m.role === 'assistant' && m.thinking).map(m => m.id),
      );
    } catch { /* 忽略 */ }
  }, [id, setMessages, thinkingDoneRef]);

  const loadList = useCallback(async () => {
    try { setChatList(await chatApi.list()); } catch { /* 忽略 */ }
  }, []);

  useEffect(() => { loadSession(); loadList(); }, [loadSession, loadList]);

  // 进入页面拉取历史消息
  useEffect(() => { loadMessages(); }, [loadMessages]);

  // 工作目录文件树（@引用候选）+ 模型候选
  useEffect(() => {
    const root = session?.workspaces[0]?.path;
    if (root) {
      fsApi.tree(root).then(tree => setFileOptions(flattenOptions(tree, root)))
        .catch(() => setFileOptions([]));
    }
  }, [session?.workspaces]);

  useEffect(() => {
    providerApi.list().then(list => {
      const models = Array.from(new Set(list.map(p => p.model))).filter(Boolean);
      setModelOptions(models.map(m => ({ value: m })));
    }).catch(() => {});
  }, []);

  // WS：状态变化 → 刷新会话与消息
  const { on: onEvent } = useLiveEventsBridge(id, () => { loadSession(); loadMessages(); });

  const handleSend = async () => {
    if (!id || !input.trim() || running) return;
    setSending(true);
    try {
      await chatApi.sendMessage(id, input.trim());
      setInput('');
      setSession(prev => prev ? { ...prev, status: 'running' } : prev);
    } catch (err: any) {
      message.error(err.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!id) return;
    try { await chatApi.stop(id); } catch (err: any) { message.error(err.message || '停止失败'); }
  };

  const handleModelChange = (v: string) => {
    setModel(v);
    if (id) chatApi.setModel(id, v || undefined).catch(() => {});
  };

  const thinkingPendingIds = useMemo(
    () => new Set(messages.filter(m => m.role === 'assistant' && m.thinking && !thinkingDoneRef.current.has(m.id)).map(m => m.id)),
    [messages, thinkingDoneRef],
  );

  const sidebar = (
    <Card size="small" style={{ height: '100%' }} bodyStyle={{ padding: 8 }}>
      <Button block type="primary" icon={<PlusOutlined />} style={{ marginBottom: 8 }} onClick={() => navigate('/chat')}>
        新建对话
      </Button>
      <List
        size="small"
        dataSource={chatList}
        locale={{ emptyText: <Empty description="暂无对话" imageStyle={{ height: 40 }} /> }}
        renderItem={(s) => (
          <List.Item
            style={{
              cursor: 'pointer', padding: '6px 8px', borderRadius: 6,
              background: s.id === id ? 'rgba(22,119,255,0.12)' : undefined,
            }}
            actions={[
              <Popconfirm key="d" title="删除该对话？" onConfirm={async (e) => {
                e?.stopPropagation();
                await chatApi.remove(s.id);
                if (s.id === id) navigate('/chat'); else loadList();
              }} onCancel={(e) => e?.stopPropagation()}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
              </Popconfirm>,
            ]}
            onClick={() => { if (s.id !== id) navigate(`/chat/${s.id}`); }}
          >
            <Space size={4} style={{ minWidth: 0 }}>
              <CommentOutlined style={{ color: s.id === id ? '#1677ff' : undefined }} />
              <Typography.Text ellipsis style={{ maxWidth: 140 }}>{s.name}</Typography.Text>
              {s.status === 'running' && <Tag color="processing">生成中</Tag>}
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );

  if (!session) return <Empty description="对话不存在" style={{ marginTop: 100 }} />;

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 120px)' }}>
      <div style={{ width: 240, flexShrink: 0, overflow: 'auto' }}>{sidebar}</div>

      <Card
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, minHeight: 0 }}
        title={
          <Space>
            <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/chat')} />
            <Typography.Text strong>{session.name}</Typography.Text>
            <Badge status={connected ? 'success' : 'error'} text={connected ? '实时连接' : '未连接'} />
          </Space>
        }
        extra={
          <Space>
            <AutoComplete
              style={{ width: 200 }}
              value={model}
              options={modelOptions}
              placeholder="模型（空=供应商默认）"
              onChange={handleModelChange}
            />
            {running && (
              <Button danger icon={<StopOutlined />} onClick={handleStop}>停止</Button>
            )}
          </Space>
        }
      >
        <ChatMessages
          messages={messages}
          thinkingPendingIds={thinkingPendingIds}
          height="100%"
        />
        <div style={{ padding: 12, borderTop: '1px solid rgba(128,128,128,0.25)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Mentions
            style={{ flex: 1 }}
            rows={2}
            value={input}
            onChange={setInput}
            placeholder="输入消息，@ 引用文件（Shift+Enter 换行）"
            prefix="@"
            options={fileOptions}
            onPressEnter={(e) => {
              if (!e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!input.trim() || running} onClick={handleSend}>
            发送
          </Button>
        </div>
      </Card>

      <PermissionModal
        request={permissionRequest}
        onAllow={() => { if (permissionRequest) { usePermissionReply(permissionRequest.id, 'approve'); setPermissionRequest(null); } }}
        onDeny={() => { if (permissionRequest) { usePermissionReply(permissionRequest.id, 'deny'); setPermissionRequest(null); } }}
        onWhitelist={() => { if (permissionRequest) { usePermissionReply(permissionRequest.id, 'whitelist'); setPermissionRequest(null); } }}
      />
    </div>
  );
}
```

上面出现两个占位名 —— **实现时按以下方式修正**（不引入新 hook）：

1. WS 状态桥：不用 `useLiveEventsBridge`。`useLiveMessages` 已返回 `on`，直接在本组件 `useEffect` 订阅：

```tsx
  const { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected, on, send } = useLiveMessages(id);

  useEffect(() => {
    const unsubs = [
      on('status_change', (data) => {
        setSession(prev => (prev ? { ...prev, status: data.status } : prev));
        if (data.status !== 'running') { loadMessages(); loadList(); }
      }),
    ];
    return () => unsubsRemove(unsubs);
  }, [on, id, loadMessages, loadList]);
```

其中清理函数写成 `return () => unsubs.forEach(fn => fn());`。

2. 权限回复：`send` 已由 `useLiveMessages` 返回，直接：

```tsx
      <PermissionModal
        request={permissionRequest}
        onAllow={() => replyPermission('approve')}
        onDeny={() => replyPermission('deny')}
        onWhitelist={() => replyPermission('whitelist')}
      />
```

```tsx
  const replyPermission = (action: 'approve' | 'deny' | 'whitelist') => {
    if (!permissionRequest) return;
    send({ type: 'permission_response', data: { reqId: permissionRequest.id, action } });
    setPermissionRequest(null);
  };
```

- [ ] **Step 4: 路由与菜单**

`src/App.tsx`：

```tsx
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ResourceManager from './pages/ResourceManager';
import StepManager from './pages/StepManager';
import PipelineList from './pages/PipelineList';
import PipelineEditor from './pages/PipelineEditor';
import SessionList from './pages/SessionList';
import SessionDetail from './pages/SessionDetail';
import SessionCreate from './pages/SessionCreate';
import ChatList from './pages/ChatList';
import ChatSession from './pages/ChatSession';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/chat" element={<ChatList />} />
        <Route path="/chat/:id" element={<ChatSession />} />
        <Route path="/resources" element={<ResourceManager />} />
        <Route path="/steps" element={<StepManager />} />
        <Route path="/pipelines" element={<PipelineList />} />
        <Route path="/pipelines/:id/edit" element={<PipelineEditor />} />
        <Route path="/pipelines/new" element={<PipelineEditor />} />
        <Route path="/sessions" element={<SessionList />} />
        <Route path="/sessions/new" element={<SessionCreate />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
      </Route>
    </Routes>
  );
}
```

`src/components/Layout.tsx` menuItems 数组第一位之后插入：

```tsx
  { key: '/chat', icon: <CommentOutlined />, label: 'Claude 对话' },
```

并在顶部 icons 导入中加入 `CommentOutlined`。

- [ ] **Step 5: 全量验证 + Commit**

Run: `npm test && npx tsc --noEmit && npm run build` → 全绿。

```bash
git add src/api/chat.ts src/pages/ChatList.tsx src/pages/ChatSession.tsx src/App.tsx src/components/Layout.tsx
git commit -m "feat: Claude 对话页（列表 + 多轮流式对话 + @引用 + 模型切换 + 停止）"
```

---

### Task 11: 收尾验证与手动验收清单

**Files:**
- Modify: `server/index.ts`（banner 补一行）
- Create: `.superpowers/sdd/progress.md`（如采用子代理执行则由流程生成；本任务只做验证）

- [ ] **Step 1: banner 更新**

`server/index.ts` banner 中 `API` 行后追加：

```ts
    console.log(`  ║           /api/chat | /api/stats | /api/fs   ║`);
```

- [ ] **Step 2: 全量回归**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 全部测试通过、tsc 无错、build 成功。

- [ ] **Step 3: 手动验收清单（交付用户）**

1. `start.bat` 启动 → 浏览器打开，**默认白色主题**；右上角切换暗色后刷新仍为暗色，切回白色。
2. 仪表盘：统计卡为真实数据；时间范围切换（今天/近7天/近30天/全部/自定义）图表随之刷新。
3. 模型配置页激活一个供应商 → 侧边栏「Claude 对话」→ 新建对话（填一个真实工作目录）。
4. 发送消息：回复逐字流式，思考过程可展开；回复结束后状态回「待输入」。
5. 输入 `@`：弹出工作目录文件候选；选中后发送，Claude 能读到该文件内容。
6. 让 Claude 编辑一个文件：弹出「编辑文件确认」弹窗，红绿 diff 正确；拒绝后文件未变；允许后修改生效。
7. 生成中点「停止」：回复立即中断，已生成部分保留在消息列表。
8. 顶部模型下拉切换 → 下一轮生效。
9. 再跑一条流水线会话后回仪表盘：Top5 会话出现两条记录，类型 Tag 分别为「对话/流水线」，点击可跳转。
10. `stop.bat`/`restart.bat` 正常；重启后对话历史仍在，继续对话上下文衔接（resume 生效）。

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "chore: 启动 banner 补充 chat/stats/fs 接口信息"
```

---

## 计划自审记录

1. **Spec 覆盖**：§1 主题（Task 1）；§2 用量采集/API/仪表盘（Task 2/3/4）；§3 会话模型（Task 5）、执行模型与 API（Task 7）、@引用与文件树（Task 6）、diff 审批（Task 8）、消息/UI 复用与路由（Task 9/10）、模型会话级切换（Task 5 PUT model + Task 10 下拉）、工作目录（Task 5/10）、停止（Task 7/10）、测试与验收（各任务 + Task 11）—— 无缺口。
2. **占位符**：无 TBD/TODO；Task 10 中出现的两个临时名（`useLiveEventsBridge`/`usePermissionReply`）已在该任务内给出替换实现，实施者按修正版写。
3. **类型一致性**：`TokenUsage`（Task 2 定义，Task 7 复用）；`ChatTurnEvent`/`ChatTurnConfig`（Task 7 定义并自用）；`FsNode`（Task 6 shared，Task 10 消费）；`DiffInfo/DiffLine`（Task 8 shared，Task 8 权限钩子与弹窗消费）；`BUILTIN_CHAT_PIPELINE_ID`（Task 3 先加入 shared，Task 5/7 复用）—— 一致。
4. **与 spec 的偏差**（已在上文标注）：`daily` 聚合为 `{date, model, tokens}` 分组（spec 的 UI 要求按模型堆叠柱图，需要按日+模型粒度，属 spec API 形状的细化）。
