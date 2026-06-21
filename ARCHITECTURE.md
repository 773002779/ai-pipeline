# AI Pipeline - 本地 Claude 流水线代码开发平台

## 架构设计文档

> 版本: 1.0 | 日期: 2026-06-19

---

## 一、技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 前端 | React 18 + TypeScript + Vite | SPA，Ant Design 组件库 |
| 后端 | Node.js + Express | REST API + WebSocket |
| 数据库 | SQLite (better-sqlite3) | 运行时状态持久化 |
| Claude 集成 | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 程序化调用 |
| 实时通信 | WebSocket (ws) | 权限确认桥接、执行状态推送 |
| 步骤存储 | YAML/Markdown 文件 | 可 Git 版本控制 |

---

## 二、核心概念模型

### 2.1 资源 (Resource) — Skill / Agent / MCP

可安装、创建、复用的资源，存储在 `.pipeline/resources/`，项目级别管理：

```typescript
type ResourceType = 'skill' | 'agent' | 'mcp';

interface Resource {
  id: string;                    // 唯一标识
  type: ResourceType;
  name: string;                  // 显示名称
  description: string;
  version: string;               // 语义化版本
  source: 'builtin' | 'claude-code' | 'manual' | 'import' | 'git';
  sourcePath?: string;           // 来源路径

  // === 各类型专属配置 ===
  config: SkillConfig | AgentConfig | McpConfig;
  
  enabled: boolean;              // 是否启用
  createdAt: Date;
  updatedAt: Date;
}

// === Skill 配置 ===
interface SkillConfig {
  prompt: string;                // Skill 的 system prompt / 行为描述
  inputSchema?: object;          // 输入参数定义
  outputSchema?: object;         // 输出格式定义
  tools?: string[];              // Skill 内部允许使用的工具
}

// === Agent 配置 ===
interface AgentConfig {
  systemPrompt: string;          // Agent 的 system prompt
  model?: string;                // 默认模型（步骤可覆盖）
  maxTokens?: number;
  tools?: string[];              // 允许的工具白名单
  mcpServerIds?: string[];       // 连接的 MCP 服务
  skillIds?: string[];           // Agent 内部可调用的 Skill
  temperature?: number;
}

// === MCP 服务配置 ===
interface McpConfig {
  command: string;               // 启动命令: "npx", "python", "node"
  args?: string[];               // 命令参数
  env?: Record<string, string>;  // 环境变量
  url?: string;                  // 远程 MCP URL（可选，与 command 二选一）
  autoApprove?: string[];        // 自动批准的工具列表
}
```

**资源存储结构**：
```
.pipeline/resources/
├── skills/
│   ├── grill-me.yaml
│   ├── code-review-expert.yaml
│   └── ...
├── agents/
│   ├── java-backend-dev.yaml
│   ├── frontend-dev.yaml
│   └── ...
└── mcp/
    ├── filesystem.yaml
    ├── github.yaml
    └── ...
```

**资源来源说明**：
| 来源 | 说明 |
|------|------|
| `builtin` | 系统内置资源（如 grill-me） |
| `claude-code` | 从用户 `~/.claude/skills/` 或 `~/.claude/CLAUDE.md` 中导入 |
| `manual` | 在 Web UI 中手动创建 |
| `import` | 从本地文件/目录导入 |
| `git` | 从 Git 仓库安装（P1） |

---

### 2.2 步骤模板 (StepTemplate)

可复用的基础步骤，纯配置，存储在 `.pipeline/steps/*.yaml`。步骤通过引用资源来获得能力：

```typescript
interface StepTemplate {
  id: string;                    // 唯一标识
  name: string;                  // "需求评审"、"TDD"、"代码实现-Java"
  category: string;              // "需求" | "分析" | "实现" | "测试" | "评审" | "工具"
  description: string;
  
  // === Claude 调用配置 ===
  systemPrompt: string;          // 核心：发给 Claude 的 system prompt
  model?: string;                // 可选模型覆盖
  maxTokens?: number;
  
  // === 工具配置（直接配置，简单步骤用）===
  tools?: string[];              // 允许使用的工具白名单

  // === 资源引用（推荐方式，替代直接配置 tools）===
  agentId?: string;              // 指定执行 Agent（可选，不填则用系统默认）
  skillIds?: string[];           // 引用的 Skills（步骤执行中可调用）
  mcpServerIds?: string[];       // 连接的 MCP 服务
  
  // 资源参数覆盖
  resourceOverrides?: {
    agent?: {
      model?: string;
      maxTokens?: number;
    };
    skills?: Record<string, {    // key = skillId
      inputParams?: Record<string, any>;
    }>;
    mcpServers?: Record<string, {
      env?: Record<string, string>;
    }>;
  };
  
  // === 交互模式 ===
  interactionMode: 'auto' | 'confirm-each' | 'auto-with-review';
  autoAdvance: boolean;          // 完成后是否自动进入下一步
  pauseForQuestions: boolean;    // (confirm-each) 暂停等待用户对话
  collectActionItems: boolean;   // (auto-with-review) 收集问题到待处理队列
  
  // === 循环配置 ===
  loopEnabled: boolean;
  defaultLoopConfig?: {
    maxIterations: number;
    terminationMode: 'ai-judge' | 'fixed' | 'until-pass';
    terminationPrompt?: string;
    checkCommand?: string;
  };
  
  // === 输入输出 ===
  inputSchema?: object;          // JSON Schema，描述输入参数
  outputFormat: 'markdown' | 'json' | 'text';
  outputTemplate?: string;
}
```

### 2.2 流水线 (Pipeline)

用户组合步骤形成的代码开发流水线：

```typescript
interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  createdAt: Date;
  updatedAt: Date;
}

interface PipelineStep {
  id: string;                    // 本步骤在流水线中的唯一 ID
  templateId: string;            // 引用的步骤模板
  order: number;
  
  // 参数覆盖（创建会话时可再次覆盖）
  overrides?: {
    systemPrompt?: string;        // 追加/覆盖 prompt
    model?: string;
    interactionMode?: string;     // 可覆盖模板的交互模式
    loopConfig?: LoopConfig;
  };
  
  // 条件执行（自然语言，AI 判断）
  condition?: string;
}

interface LoopConfig {
  maxIterations: number;
  terminationMode: 'ai-judge' | 'fixed' | 'until-pass';
  terminationPrompt?: string;
  checkCommand?: string;
}
```

### 2.3 会话 (Session)

基于流水线创建的一次执行实例：

```typescript
type SessionStatus = 
  | 'idle'            // 已创建，未开始
  | 'precheck'        // 预检中
  | 'running'         // 当前步骤执行中
  | 'waiting_confirm' // 等待用户在 Web 端确认
  | 'paused'          // 用户手动暂停
  | 'error'           // 异常中断
  | 'completed'       // 全部完成
  | 'cancelled';      // 用户取消

interface Session {
  id: string;
  pipelineId: string;
  pipelineSnapshot: Pipeline;    // 创建时的流水线快照
  
  name: string;
  requirement: string;           // 用户输入的需求描述（流水线起点）
  status: SessionStatus;
  
  // 工作区
  workspaces: Workspace[];
  
  // 环境上下文（预检后填充）
  environment?: EnvironmentContext;
  
  // 步骤执行状态
  currentStepIndex: number;
  steps: SessionStep[];
  
  // 覆盖
  stepOverrides?: Record<string, PipelineStep['overrides']>;
  
  createdAt: Date;
  updatedAt: Date;
}

interface Workspace {
  name: string;        // 模块名
  path: string;        // 代码路径
  type: 'frontend' | 'backend' | 'fullstack' | 'library' | 'unknown';
}

interface EnvironmentContext {
  workspaces: WorkspaceEnv[];
  availableTools: string[];      // ["java", "mvn", "node", "npm", "git"]
  missingButNeeded: string[];    // 步骤需要但未安装的工具
  detectedAt: Date;
}

interface WorkspaceEnv {
  name: string;
  path: string;
  techStack: string[];           // ["java-17", "spring-boot-3", "maven"]
  dependencies?: Record<string, string>;
}

interface SessionStep {
  templateId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  errorMessage?: string;
  retryCount: number;
}
```

### 2.4 待处理项 (ActionItem)

流水线执行中收集的问题：

```typescript
interface ActionItem {
  id: string;
  sessionId: string;
  stepId: string;
  severity: 'error' | 'warning' | 'suggestion' | 'question';
  title: string;
  description: string;
  file?: string;
  line?: number;
  status: 'pending' | 'accepted' | 'rejected' | 'deferred';
  resolution?: string;
  createdAt: Date;
}
```

### 2.5 权限确认 (PermissionRequest)

```typescript
interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: object;
  message: string;
  risk: 'low' | 'medium' | 'high';
  timestamp: Date;
  status: 'pending' | 'approved' | 'denied';
}
```

---

## 三、状态机

```
                    ┌─────────┐
                    │  idle   │
                    └────┬────┘
                         │ 用户点击"开始"
                         ▼
                    ┌──────────┐
                    │ precheck │──→ 缺失关键工具 → 提示用户安装 → precheck
                    └────┬─────┘
                         │ 预检通过
                         ▼
              ┌──────────────────┐
              │    running       │←──────────────────────────────┐
              │ (执行当前步骤)    │                               │
              └───┬──────┬───────┘                               │
                  │      │                                       │
    步骤完成      │      │ AI 请求交互                            │
    autoAdvance? │      │ (confirm-each)                         │
                  │      ▼                                       │
        ┌──是────┤  ┌───────────────┐                            │
        │        │  │waiting_confirm│──→ 用户响应 → running ─────┘
        ▼        │  └───────────────┘
   下一个步骤     │
        │        │  用户点击暂停
        │ 否     ▼
        │    ┌────────┐
        │    │ paused │──→ 用户恢复 → running
        │    └────────┘
        │        用户取消
        │        ▼
        │    ┌──────────┐
        │    │ cancelled│
        │    └──────────┘
        │
        │  异常/崩溃
        ▼
    ┌───────┐
    │ error │──→ 用户重试 → running (从当前步骤开头重做)
    └───┬───┘
        │ 用户取消
        ▼
   ┌──────────┐
   │ cancelled│
   └──────────┘
        │
        │ 所有步骤完成
        ▼
   ┌───────────┐
   │ completed │
   └───────────┘
```

---

## 四、架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser (React SPA)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐  │
│  │Dashboard │ │Steps Mgr │ │Pipeline  │ │ Session Detail     │  │
│  │          │ │          │ │ Editor   │ │ - Step Progress    │  │
│  │          │ │          │ │          │ │ - Live Chat        │  │
│  │          │ │          │ │          │ │ - Permission Modal │  │
│  └──────────┘ └──────────┘ └──────────┘ │ - Action Items     │  │
│                                          └────────────────────┘  │
└──────────────┬───────────────────────────────┬───────────────────┘
               │ REST API (HTTP)               │ WebSocket
               ▼                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Node.js Backend (Express)                       │
│                                                                    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ REST Router │  │ WS Manager   │  │ Pipeline Executor       │  │
│  │ - /api/     │  │ - session/:id│  │ - Step Scheduler        │  │
│  │   steps     │  │   channel    │  │ - Context Builder       │  │
│  │   pipelines │  │ - broadcast  │  │ - Output Collector      │  │
│  │   sessions  │  │   status     │  │ - Action Item Collector │  │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────┘  │
│         │                │                      │                 │
│         ▼                ▼                      ▼                 │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐  │
│  │   SQLite DB  │  │         Claude Agent Manager              │  │
│  │              │  │  - Agent SDK 调用                         │  │
│  │  sessions    │  │  - Permission Hook 拦截                   │  │
│  │  pipelines   │  │  - Tool Use 监控                         │  │
│  │  step_tmpl   │  │  - Streaming 输出                         │  │
│  │  action_items│  └──────────────────────────────────────────┘  │
│  │  messages    │                                                │
│  └──────────────┘                                                │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              Precheck Engine                               │    │
│  │  - 工作区扫描 (检测 package.json, pom.xml, etc.)           │    │
│  │  - 工具链检测 (java, node, npm, git, python, rust...)     │    │
│  │  - 缺失工具提醒 (非阻塞，仅当步骤需要时强制)                │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     File System                                    │
│                                                                    │
│  .pipeline/                      ← 项目级配置                     │
│    steps/                        ← 步骤模板 YAML                  │
│      grill-me.yaml                                                │
│      requirement-review.yaml                                       │
│      source-analysis.yaml                                          │
│      ...                                                           │
│    pipelines/                    ← 流水线定义 YAML                │
│                                                                    │
│  workspace/                      ← 会话工作区                     │
│    {sessionId}/                                                    │
│      output/                     ← 步骤输出文档                   │
│        step-01-requirement-review.md                              │
│        step-02-source-analysis.md                                  │
│        ...                                                         │
│        final-report.md                                             │
│        action-items.json                                           │
│      artifacts/                  ← AI 产生的代码变更              │
│      logs/                       ← 执行日志                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## 五、数据流

### 5.1 步骤执行流程

```
1. Session Executor 获取当前步骤
2. Context Builder 构造上下文：
   ├── requirement（用户原始需求描述）
   ├── previousOutputs（前面所有步骤的输出 + AI 生成的摘要）
   ├── workspace（全部工作区信息）
   ├── environment（预检环境上下文）
   └── actionItems（已收集的待处理项）
3. Resource Resolver 解析步骤引用的资源：
   ├── 解析 agentId → 加载 Agent 配置（systemPrompt、model、tools）
   ├── 解析 skillIds → 加载 Skill 配置，注入到 agent prompt 中
   ├── 解析 mcpServerIds → 启动/连接 MCP 服务
   └── 应用 resourceOverrides 覆盖参数
4. Claude Agent Manager 启动 Agent：
   ├── 合并步骤 systemPrompt + Agent prompt + Skill prompts
   ├── 合并步骤 tools + Agent tools + MCP tools
   ├── 注册 Permission Hook
   └── 开始 streaming 输出到 WebSocket
5. 执行中：
   ├── AI 自行判断操作哪个工作区
   ├── AI 产出代码/文档
   ├── Permission Hook 拦截 tool_use → 转 WebSocket → 等待用户确认
   ├── confirm-each 模式下 AI 提问 → 暂停 → 用户回答 → 继续
   └── auto-with-review 模式收集 ActionItem
6. 步骤完成：
   ├── 保存输出文档到 workspace/{sessionId}/output/
   ├── 更新 SessionStep 状态
   ├── autoAdvance? → 自动执行下一步 : 等待用户确认
   └── WebSocket 推送状态更新
7. 全部步骤完成：
   └── 展示待处理项列表 → 用户逐项处理 → 可选触发修复流水线
```

### 5.2 权限确认流程

```
Claude Agent → tool_use 事件
     │
     ▼
Permission Hook 拦截
     │
     ├── 检查白名单（后端 session 级别）
     │   ├── 已授权 → 直接放行
     │   └── 未授权 ↓
     │
     ├── 高风险操作 (rm -rf, force push, etc.)
     │   └── 始终要求确认（不可白名单）
     │
     ▼
创建 PermissionRequest
     │
     ▼
WebSocket → 前端弹窗
     ├── 显示: 工具名、参数、风险等级
     ├── 选项: [允许一次] [拒绝] [本次会话始终允许]
     │
     ▼
用户选择 → WebSocket → 后端
     ├── 允许: Agent 继续，可选写入白名单
     └── 拒绝: Agent 收到拒绝，尝试替代方案
```

### 5.3 上下文累积策略

```
步骤1（需求确认）执行
  ↓ 输出 → {workspace}/{sessionId}/output/step-01-*.md
  
步骤2（源码分析）执行
  ↓ 上下文 = {
      requirement: "...",
      previousOutputs: [
        { stepId: 1, summary: "AI生成的需求确认摘要...", path: "..." }
      ],
      workspaces: [...],
      environment: {...}
    }
  ↓ 输出 → {workspace}/{sessionId}/output/step-02-*.md

步骤3（代码实现）执行
  ↓ 上下文 = {
      requirement: "...",
      previousOutputs: [
        { stepId: 1, summary: "...", path: "..." },
        { stepId: 2, summary: "...", path: "..." }
      ],
      ...
    }
  ...以此类推，每个后续步骤都能看到前面所有步骤的摘要和完整输出路径
```

---

## 六、数据库表设计 (SQLite)

```sql
-- 资源 (Skill / Agent / MCP)
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('skill', 'agent', 'mcp')),
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL CHECK (source IN ('builtin', 'claude-code', 'manual', 'import', 'git')),
  source_path TEXT,               -- 来源路径
  config_json TEXT NOT NULL,      -- 完整配置 (SkillConfig/AgentConfig/McpConfig)
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 步骤模板（从 YAML 文件加载后的运行时缓存）
CREATE TABLE step_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  config_json TEXT NOT NULL,     -- 完整 JSON（含 resourceRefs）
  source_path TEXT,              -- 来源 YAML 文件路径
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 流水线定义
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  definition_json TEXT NOT NULL,  -- 完整 Pipeline 对象的 JSON
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 会话
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  pipeline_snapshot TEXT NOT NULL, -- 创建时的流水线快照
  name TEXT NOT NULL,
  requirement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  workspaces_json TEXT NOT NULL,   -- Workspace[]
  environment_json TEXT,           -- EnvironmentContext (预检后)
  current_step_index INTEGER DEFAULT 0,
  step_overrides_json TEXT,        -- 会话级别的步骤参数覆盖
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines(id)
);

-- 会话步骤执行记录
CREATE TABLE session_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  output_path TEXT,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 对话消息（会话详情页的自由对话 + 步骤中的交互对话）
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step_id TEXT,                    -- 关联步骤（可选，自由对话为 NULL）
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  tool_calls_json TEXT,            -- 工具调用记录
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 待处理项
CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  severity TEXT NOT NULL,          -- 'error' | 'warning' | 'suggestion' | 'question'
  title TEXT NOT NULL,
  description TEXT,
  file_path TEXT,
  line_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 权限白名单（session 级别）
CREATE TABLE permission_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, tool_name)
);

-- 索引
CREATE INDEX idx_resources_type ON resources(type);
CREATE INDEX idx_resources_enabled ON resources(enabled);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_session_steps_session ON session_steps(session_id);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_action_items_session ON action_items(session_id);
CREATE INDEX idx_action_items_status ON action_items(session_id, status);
```

---

## 七、API 设计

### 7.1 REST API

```
# 资源管理 (Skill / Agent / MCP)
GET    /api/resources                       # 列表（支持 ?type= 筛选）
GET    /api/resources/:id                   # 详情
POST   /api/resources                       # 手动创建
PUT    /api/resources/:id                   # 更新
DELETE /api/resources/:id                   # 删除
POST   /api/resources/import                # 导入 (from claude-code / local file / git)
POST   /api/resources/:id/validate          # 验证资源配置
POST   /api/resources/:id/toggle            # 启用/禁用

# 步骤模板
GET    /api/steps                  # 列表
GET    /api/steps/:id              # 详情
POST   /api/steps                  # 创建（写入 YAML）
PUT    /api/steps/:id              # 更新
DELETE /api/steps/:id              # 删除
POST   /api/steps/import           # 导入 YAML 文件

# 流水线
GET    /api/pipelines              # 列表
GET    /api/pipelines/:id          # 详情
POST   /api/pipelines              # 创建
PUT    /api/pipelines/:id          # 更新
DELETE /api/pipelines/:id          # 删除
POST   /api/pipelines/:id/validate # 验证流水线配置

# 会话
GET    /api/sessions               # 列表（支持 ?status= 筛选）
GET    /api/sessions/:id           # 详情（含步骤状态）
POST   /api/sessions               # 创建
POST   /api/sessions/:id/start     # 开始执行
POST   /api/sessions/:id/pause     # 暂停
POST   /api/sessions/:id/resume    # 恢复
POST   /api/sessions/:id/retry     # 重试当前步骤
POST   /api/sessions/:id/cancel    # 取消
POST   /api/sessions/:id/clone     # 克隆新会话
POST   /api/sessions/:id/precheck  # 运行预检

# 会话步骤
GET    /api/sessions/:id/steps/:stepId/output    # 获取步骤输出文档
POST   /api/sessions/:id/steps/:stepId/respond   # 用户响应 AI 提问

# 对话
GET    /api/sessions/:id/messages                # 历史消息
POST   /api/sessions/:id/messages                # 发送消息（自由对话）

# 待处理项
GET    /api/sessions/:id/action-items             # 列表
PUT    /api/sessions/:id/action-items/:itemId     # 更新状态
POST   /api/sessions/:id/action-items/export      # 导出（GitHub Issues / TODO.md）

# 权限
POST   /api/sessions/:id/permissions/:reqId       # 响应权限请求
GET    /api/sessions/:id/permissions/whitelist    # 查看白名单
DELETE /api/sessions/:id/permissions/whitelist/:tool  # 移除白名单项
```

### 7.2 WebSocket 通道

```
ws://localhost:3001/ws/session/:id

# 服务端 → 客户端事件：
{
  type: 'status_change',        # 会话状态变化
  data: { status: 'running', currentStepIndex: 2 }
}
{
  type: 'step_progress',        # 步骤执行进度
  data: { stepName: '代码实现', progress: 75, currentAction: 'Editing...' }
}
{
  type: 'ai_message',           # AI 流式输出
  data: { content: '正在分析...', done: false, stepId: 'step-3' }
}
{
  type: 'permission_request',   # 权限确认请求
  data: { id: 'perm-001', toolName: 'Bash', message: '...', risk: 'medium' }
}
{
  type: 'tool_use',             # 工具调用通知
  data: { toolName: 'Edit', input: {...} }
}
{
  type: 'action_item',          # 新待处理项
  data: { id: 'ai-001', severity: 'warning', title: '...' }
}
{
  type: 'step_complete',        # 步骤完成
  data: { stepId: 'step-2', outputPath: '...' }
}

# 客户端 → 服务端事件：
{
  type: 'chat_message',         # 用户发送对话
  data: { content: '请解释这个设计决策' }
}
{
  type: 'permission_response',  # 用户响应权限
  data: { reqId: 'perm-001', action: 'approve' | 'deny' | 'whitelist' }
}
{
  type: 'step_response',        # 用户响应 AI 提问
  data: { stepId: 'step-1', content: '同意，继续' }
}
```

---

## 八、前端页面设计

### 8.1 页面路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | Dashboard | 总览：活跃会话数、最近流水线、待处理项统计、资源统计 |
| `/resources` | 资源管理 | Skill/Agent/MCP 的 CRUD、导入、启用/禁用 |
| `/resources/:id` | 资源详情/编辑 | 资源的配置编辑、测试运行、关联的步骤查看 |
| `/steps` | 步骤管理 | 步骤模板 CRUD，YAML 导入/导出，步骤中引用资源 |
| `/pipelines` | 流水线列表 | 流水线卡片列表 |
| `/pipelines/:id/edit` | 流水线编辑器 | 拖拽列表式编辑器 |
| `/sessions` | 会话列表 | 按状态筛选、搜索 |
| `/sessions/:id` | 会话详情 | 核心页面（见下方详图） |

### 8.2 会话详情页布局

```
┌─ 会话详情: 电商系统后端开发 ────────── [⏸️暂停] [↻重启] [🗑️取消] ──┐
│  流水线: Java后端开发   状态: 🟢 执行中   工作区: user-api, user-web │
├─ 步骤进度 ─────────────────────────────────────────────────────────┤
│                                                                     │
│  ✅ 需求确认          [📄输出]          14:30-14:45 (15min)         │
│  ✅ 源码分析          [📄输出]          14:45-15:00 (15min)         │
│  🔵 代码实现-Java     执行中...         15:00-现在   进度 75%       │
│     └─ AI 正在编辑: src/main/java/.../UserService.java             │
│  ⏳ 代码评审          等待中                                       │
│  ⏳ TDD验证           等待中 (循环: 最多5次)                        │
│                                                                     │
├─ 🤖 Claude Opus 4.8 │ 🟢 执行中 │ Token: 12k/200k │ 耗时: 32min  │
├─ 对话区 ───────────────────────────────────────────────────────────┤
│                                                                     │
│  [15:02] 🤖 正在分析 UserService.java...                            │
│  [15:03] 🤖 发现以下问题：密码未加密、缺少输入校验。正在修复...       │
│  [15:04] ⚡ Edit: src/main/java/.../UserService.java                │
│  [15:05] 🤖 已添加 BCrypt 加密和 @Valid 校验。生成 UserServiceTest:  │
│                                                                     │
│  ┌─ ⚠️ 权限确认 ──────────────────────────────────┐                │
│  │                                                 │                │
│  │  Claude 想要执行: mvn test -Dtest=UserServiceTest│                │
│  │  风险: 🟡 中                                    │                │
│  │  详情: 将运行单元测试，不会修改生产数据            │                │
│  │                                                 │                │
│  │  [✅ 允许一次] [⛔ 拒绝] [🔓 本次会话始终允许]    │                │
│  └─────────────────────────────────────────────────┘                │
│                                                                     │
│  ┌────────────────────────────────────────────────┐                 │
│  │ 💬 输入消息...                           [发送] │                 │
│  └────────────────────────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.3 创建会话向导

```
步骤 1/2: 配置基本信息
┌──────────────────────────────────────────────────────────┐
│ 创建新会话                                                │
│                                                           │
│ 流水线模板: [Java后端开发模板       ▼]                     │
│ 会话名称:   [电商用户模块开发________]                     │
│                                                           │
│ 工作区:                                                   │
│ ┌──────────┬──────────────────────┬──────────┬─────┐     │
│ │ 模块名    │ 代码路径              │ 类型      │ 操作 │     │
│ ├──────────┼──────────────────────┼──────────┼─────┤     │
│ │ user-api │ d:/projects/backend   │ 🔙 后端   │ ❌  │     │
│ │ user-web │ d:/projects/frontend  │ 🔜 前端   │ ❌  │     │
│ └──────────┴──────────────────────┴──────────┴─────┘     │
│                                           [+ 添加工作区] │
│                                                           │
│ 需求描述 (流水线起点):                                     │
│ ┌──────────────────────────────────────────────────────┐  │
│ │ 开发电商系统的用户模块，包括：                          │  │
│ │ 1. 用户注册（手机号+邮箱）                             │  │
│ │ 2. 登录（JWT认证）                                    │  │
│ │ 3. 个人信息管理（修改密码、头像上传）                    │  │
│ │ 4. 地址管理（增删改查）                                │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                           │
│                              [下一步: 预览流水线]          │
└──────────────────────────────────────────────────────────┘

步骤 2/2: 预览并开始
┌──────────────────────────────────────────────────────────┐
│ 流水线预览                         预计耗时: 30-60分钟     │
│                                                           │
│ ╔══ 预检 (自动) ═══════════════════════════════════════╗  │
│ ║ 检测工作区技术栈，验证工具链可用性                     ║  │
│ ╚══════════════════════════════════════════════════════╝  │
│    ↓                                                      │
│ 1. 📝 需求确认 (需交互)                                    │
│    ├─ 交互模式: confirm-each                               │
│    └─ 与您对话确认需求的细节和优先级                        │
│    ↓                                                      │
│ 2. 🔍 源码分析 (自动)                                      │
│    ├─ 交互模式: auto                                       │
│    └─ AI 自行判断操作哪个工作区                            │
│    ↓                                                      │
│ 3. 💻 Java后端实现 (自动 + 收集问题)                       │
│    ├─ 交互模式: auto-with-review                           │
│    └─ 自动编码，问题记录到待处理列表                        │
│    ↓                                                      │
│ 4. 🎨 前端实现 (自动 + 收集问题)                           │
│    ├─ 交互模式: auto-with-review                           │
│    └─ 自动编码，问题记录到待处理列表                        │
│    ↓                                                      │
│ 5. ✅ 代码评审 (自动 + 收集问题)                           │
│    ├─ 交互模式: auto-with-review                           │
│    └─ 评审报告 + 问题列表                                 │
│    ↓                                                      │
│ 6. 🔁 TDD验证 (循环: 最多5次, AI判断终止)                  │
│    ├─ 3.1 生成测试 → 3.2 运行测试 → 3.3 修复实现          │
│    └─ 直到所有测试通过或达到最大次数                        │
│                                                           │
│ ┌─ 步骤参数覆盖 (可选) ────────────────────────────────┐  │
│ │ 步骤 "代码评审":                                       │  │
│ │   严格程度: [标准 ▼] 标准/宽松/严格/极严格             │  │
│ │   关注重点: [安全性、性能、代码规范__________________]  │  │
│ └────────────────────────────────────────────────────┘  │
│                                                           │
│                            [← 返回修改] [🚀 开始执行]      │
└──────────────────────────────────────────────────────────┘
```

### 8.4 流水线编辑器

```
┌─ 编辑流水线: Java后端开发模板 ──────────────────────────────────┐
│                                                                   │
│ ┌─ 可用步骤 ────────────────────────────┐ ┌─ 流水线步骤 ────────┐│
│ │ 🔍 搜索: [________]                   │ │                     ││
│ │                                        │ │ ┌── 1 ──────────┐  ││
│ │ 📝 需求评审        [+ 拖入]            │ │ │ 📝 需求确认    │  ││
│ │ 🔍 源码分析        [+ 拖入]            │ │ │ confirm-each  │  ││
│ │ 📋 需求确认        [+ 拖入]            │ │ │ autoAdvance ✓ │  ││
│ │ 💻 Java后端实现    [+ 拖入]            │ │ │ [⚙️] [✕]     │  ││
│ │ 🎨 前端实现        [+ 拖入]            │ │ └──────────────┘  ││
│ │ 🐍 Python实现      [+ 拖入]            │ │        ↓           ││
│ │ 🦀 Rust实现        [+ 拖入]            │ │ ┌── 2 ──────────┐  ││
│ │ 🧪 TDD验证         [+ 拖入]            │ │ │ 🔍 源码分析   │  ││
│ │ ✅ 代码评审        [+ 拖入]            │ │ │ auto          │  ││
│ │ 📖 文档生成        [+ 拖入]            │ │ │ autoAdvance ✓ │  ││
│ │ 🔧 自定义...                          │ │ │ [⚙️] [✕]     │  ││
│ └────────────────────────────────────────┘ │ └──────────────┘  ││
│                                            │        ↓           ││
│                                            │ ┌── 3 ──────────┐  ││
│                                            │ │ 💻 Java实现    │  ││
│                                            │ │ auto-with-    │  ││
│                                            │ │   review      │  ││
│                                            │ │ autoAdvance ✓ │  ││
│                                            │ │ [⚙️] [✕]     │  ││
│                                            │ └──────────────┘  ││
│                                            │        ↓           ││
│                                            │ ┌── 4 ──────────┐  ││
│                                            │ │ 🔁 TDD验证    │  ││
│                                            │ │ 🔄 循环:       │  ││
│                                            │ │  最多 5次      │  ││
│                                            │ │  终止: AI判断  │  ││
│                                            │ │ [⚙️] [✕]     │  ││
│                                            │ └──────────────┘  ││
│                                            │        ↓           ││
│                                            │ [+ 添加步骤]       ││
│                                            └────────────────────┘│
│                                                                   │
│                                          [保存流水线] [另存为...]  │
└───────────────────────────────────────────────────────────────────┘
```

### 8.5 流水线编辑器（步骤引用资源时的交互）

当编辑步骤、引用 Skill/Agent/MCP 时，资源选择器内嵌在步骤配置面板中：

```
┌─ 步骤配置: Java后端实现 ──────────────────────────────────┐
│                                                             │
│  步骤名称: [Java后端实现___________________]                │
│  类别:     [实现 ▼]                                        │
│  交互模式: [auto-with-review ▼]                            │
│  ☑ 完成后自动执行下一步                                     │
│                                                             │
│  ── 资源引用 ──────────────────────────────────────────    │
│                                                             │
│  Agent:  [java-backend-dev        ▼] [📋查看] [➕新建]     │
│          ┌─────────────────────────────────────────┐       │
│          │ java-backend-dev v1.2 (agent)            │       │
│          │ Java 17, Spring Boot 3, Maven 工具链     │       │
│          │ 最近更新: 2026-06-15                     │       │
│          └─────────────────────────────────────────┘       │
│                                                             │
│  Skills: [📦源码结构分析 ✕] [📦命名规范检查 ✕]             │
│          [+ 添加 Skill]                                    │
│          ┌─────────────────────────────────────────┐       │
│          │ 📦 源码结构分析 (skill)                   │       │
│          │ 📦 命名规范检查 (skill)                   │       │
│          │ 🔍 搜索更多...                           │       │
│          └─────────────────────────────────────────┘       │
│                                                             │
│  MCP:    [🔌 github ✕] [🔌 filesystem ✕]                   │
│          [+ 添加 MCP]                                      │
│                                                             │
│  ── 资源参数覆盖 ──────────────────────────────────────    │
│  Agent 模型: [保留默认 ▼] 保留默认/Opus/Sonnet/Haiku      │
│  Skill 参数:                                               │
│    📦 源码结构分析:                                         │
│      深度: [标准 ▼]      输出格式: [json ▼]                │
│                                                             │
│  ── System Prompt ────────────────────────────────────    │
│  ┌──────────────────────────────────────────────────┐     │
│  │ 你是一个资深的 Java 后端开发工程师...              │     │
│  │ (可使用 {skill:xxx} 和 {agent:xxx} 引用资源)      │     │
│  └──────────────────────────────────────────────────┘     │
│                                                             │
│                              [保存步骤] [取消]               │
└─────────────────────────────────────────────────────────────┘
```

### 8.6 资源管理页面

```
┌─ 资源管理 ──────────────────────── [➕ 新建] [📥 导入] ────┐
│                                                             │
│  [全部(12)] [Skills(5)] [Agents(4)] [MCPs(3)]               │
│                                                             │
│ ┌─ 📦 grill-me ────────────────── [skill] [✅ 已启用] ───┐ │
│ │ 需求/设计对抗性审查                                     │ │
│ │ 版本: 1.0.0 | 来源: builtin | 被 3 个步骤引用           │ │
│ │ [📋编辑] [📋查看关联步骤] [⏸️禁用] [🗑️删除]           │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ 🤖 java-backend-dev ─────────── [agent] [✅ 已启用] ───┐ │
│ │ Java 17 + Spring Boot 3 开发 Agent                       │ │
│ │ 版本: 1.2.0 | 来源: manual | 被 2 个步骤引用             │ │
│ │ [📋编辑] [📋查看关联步骤] [⏸️禁用] [🗑️删除]           │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ 🔌 github ───────────────────── [mcp] [✅ 已启用] ────┐ │
│ │ GitHub Issues / PR 管理                                  │ │
│ │ 版本: 2.1.0 | 来源: git | 被 4 个步骤引用                │ │
│ │ [📋编辑] [📋查看关联步骤] [⏸️禁用] [🗑️删除]           │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ 📦 code-review-expert ─────── [skill] [⏸️ 已禁用] ───┐ │
│ │ 深度代码评审专家 Skill                                   │ │
│ │ 版本: 0.9.0-beta | 来源: import | 未被引用               │ │
│ │ [📋编辑] [🔄启用] [🗑️删除]                              │ │
│ └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**导入资源弹窗**：
```
┌─ 导入资源 ────────────────────────────────────┐
│                                                 │
│ 导入来源:                                       │
│  ○ 从 Claude Code 导入                          │
│    路径: [~/.claude/skills/      ] [📁浏览]    │
│    将自动扫描目录下的 skill/agent/mcp 配置       │
│                                                 │
│  ○ 从本地文件导入                               │
│    文件: [                           ] [📁选择] │
│                                                 │
│  ● 从 Git 仓库安装 (P1)                         │
│    URL:  [https://github.com/xxx/skill]          │
│    Branch:[main                   ]             │
│                                                 │
│  ○ 手动创建                                     │
│    类型: [Skill ▼]  Skill / Agent / MCP         │
│    名称: [________________________]              │
│                                                 │
│                           [取消] [导入/创建]     │
└─────────────────────────────────────────────────┘
```

### 8.7 待处理项面板（会话完成后的侧边面板）

```
┌─ 待处理项 ──────────────────────────────────────────────┐
│ 📋 代码评审发现问题 (共 12 项)                            │
│                                                          │
│ 🔴 错误 (2)                                              │
│  □ UserService.java:42 — 未处理 SQLException             │
│    └─ 来自: 代码评审步骤                                 │
│  □ AuthController.java:18 — 密码明文日志输出              │
│    └─ 来自: 代码评审步骤                                 │
│                                                          │
│ 🟡 警告 (5)                                              │
│  □ UserUtils.java:108 — 方法圈复杂度 14 (>10)            │
│  □ pom.xml — spring-boot 版本 3.1 (有 CVE)               │
│  ...                                                     │
│                                                          │
│ 🔵 建议 (5)                                              │
│  □ 建议 UserService 使用 Optional 替代 null 返回          │
│  ...                                                     │
│                                                          │
│ [✅ 全部接受] [📋 逐项处理]                               │
│ [📤 导出 GitHub Issues] [📝 导出 TODO.md]                 │
│ [🤖 创建修复流水线]                                       │
└──────────────────────────────────────────────────────────┘
```

---

## 九、预设资源

系统内置以下资源（存储在 `.pipeline/resources/`）：

### Skills
| 文件名 | 名称 | 描述 |
|--------|------|------|
| `grill-me.yaml` | 需求/设计对抗审查 | 对设计进行 relentless 的对抗性审查 |
| `code-review-expert.yaml` | 深度代码评审 | 关注正确性、安全、性能、可维护性 |
| `naming-check.yaml` | 命名规范检查 | 检查代码命名是否符合语言惯例 |
| `source-structure.yaml` | 源码结构分析 | 分析项目模块结构和依赖关系 |

### Agents
| 文件名 | 名称 | 描述 |
|--------|------|------|
| `default.yaml` | 默认 Agent | 通用 Claude 实例，无特殊配置 |
| `java-backend-dev.yaml` | Java 后端开发 | Java 17, Spring Boot 3, Maven 工具链 |
| `frontend-dev.yaml` | 前端开发 | React/Vue, TypeScript, npm/yarn 工具链 |
| `python-dev.yaml` | Python 开发 | Python 3.11+, pytest, mypy 工具链 |

### MCP Servers
| 文件名 | 名称 | 描述 |
|--------|------|------|
| `filesystem.yaml` | 文件系统 | 增强的文件读写能力 |
| `github.yaml` | GitHub 集成 | Issues/PR 管理（P1） |

---

## 十、预设步骤模板

系统内置以下步骤模板（存储在 `.pipeline/steps/`）：

| 文件名 | 名称 | 类别 | 交互模式 |
|--------|------|------|---------|
| `grill-me.yaml` | 需求/设计对抗审查 | 需求 | confirm-each |
| `requirement-review.yaml` | 需求评审 | 需求 | confirm-each |
| `requirement-confirm.yaml` | 需求确认 | 需求 | confirm-each |
| `source-analysis.yaml` | 源码分析 | 分析 | auto |
| `code-review.yaml` | 代码评审 | 评审 | auto-with-review |
| `tdd.yaml` | TDD 验证 | 测试 | auto |
| `implement-java.yaml` | Java 后端实现 | 实现 | auto-with-review |
| `implement-frontend.yaml` | 前端实现 | 实现 | auto-with-review |
| `implement-python.yaml` | Python 实现 | 实现 | auto-with-review |
| `implement-rust.yaml` | Rust 实现 | 实现 | auto-with-review |
| `generate-tests.yaml` | 生成测试 | 测试 | auto |
| `generate-docs.yaml` | 生成文档 | 工具 | auto |

---

## 十一、预设流水线模板

| 名称 | 步骤组合 | 适用场景 |
|------|---------|---------|
| Java 后端开发 | 需求确认 → 源码分析 → Java实现 → 代码评审 → TDD | Spring Boot 项目 |
| 前端开发 | 需求确认 → 源码分析 → 前端实现 → 代码评审 → TDD | React/Vue 项目 |
| 全栈开发 | 需求确认 → 后端实现 → 前端实现 → 集成测试 → 代码评审 | 全栈项目 |
| 纯评审 | 源码分析 → 代码评审 | 仅审不写 |
| TDD 驱动 | TDD × N（循环） | 测试驱动开发 |
| 需求审查 | grill-me → 需求确认 | 需求澄清 |

---

## 十二、项目结构

```
ai-pipeline/
├── package.json
├── vite.config.ts
├── tsconfig.json
│
├── server/                          # 后端
│   ├── index.ts                     # 入口
│   ├── app.ts                       # Express 配置
│   ├── config.ts                    # 配置
│   ├── db/
│   │   ├── connection.ts            # SQLite 连接
│   │   ├── schema.ts                # 建表
│   │   └── repositories/           # 数据访问层
│   │       ├── resources.ts         # ★ 资源
│   │       ├── steps.ts
│   │       ├── pipelines.ts
│   │       ├── sessions.ts
│   │       ├── messages.ts
│   │       └── action-items.ts
│   ├── routes/                      # REST API
│   │   ├── resources.ts             # ★ 资源管理
│   │   ├── steps.ts
│   │   ├── pipelines.ts
│   │   ├── sessions.ts
│   │   ├── messages.ts
│   │   ├── action-items.ts
│   │   └── permissions.ts
│   ├── ws/
│   │   └── session-channel.ts       # WebSocket 管理
│   ├── engine/
│   │   ├── executor.ts              # 流水线执行器
│   │   ├── context-builder.ts       # 上下文构造器
│   │   ├── precheck.ts              # 预检引擎
│   │   ├── output-collector.ts      # 输出收集器
│   │   └── resource-resolver.ts     # ★ 资源解析器
│   ├── claude/
│   │   ├── agent-manager.ts         # Claude Agent 管理
│   │   ├── permission-hook.ts       # 权限拦截
│   │   └── streaming.ts             # 流式输出处理
│   ├── resources/                   # ★ 资源加载
│   │   ├── loader.ts                # YAML 加载器
│   │   ├── importer.ts              # 导入器
│   │   └── builtin/                 # ★ 内置资源
│   └── steps/                       # 步骤模板加载
│       ├── loader.ts                # YAML 加载器
│       └── builtin/                 # 内置模板
│
├── src/                             # 前端 React
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/                         # API 调用
│   │   ├── client.ts                # fetch 封装
│   │   ├── resources.ts            # ★ 资源 API
│   │   ├── steps.ts
│   │   ├── pipelines.ts
│   │   └── sessions.ts
│   ├── hooks/
│   │   ├── useWebSocket.ts          # WebSocket hook
│   │   ├── useSession.ts
│   │   └── usePermission.ts
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── ResourceManager.tsx     # ★ 资源管理页
│   │   ├── StepManager.tsx
│   │   ├── PipelineList.tsx
│   │   ├── PipelineEditor.tsx
│   │   ├── SessionList.tsx
│   │   ├── SessionDetail.tsx
│   │   └── SessionCreate.tsx        # 创建向导
│   ├── components/
│   │   ├── Layout.tsx               # 主布局
│   │   ├── StepProgress.tsx         # 步骤进度条
│   │   ├── ChatPanel.tsx            # 对话面板
│   │   ├── PermissionModal.tsx      # 权限确认弹窗
│   │   ├── ActionItemPanel.tsx      # 待处理项面板
│   │   ├── OutputViewer.tsx         # Markdown 输出查看器
│   │   ├── StepCard.tsx             # 步骤卡片（拖拽用）
│   │   ├── WorkspaceInput.tsx       # 工作区输入组件
│   │   └── PipelinePreview.tsx      # 流水线预览
│   └── types/
│       └── index.ts                 # 共享类型定义
│
└── .pipeline/                       # 项目级配置（可 Git）
    ├── resources/                   # ★ 资源 (skills/agents/mcp)
    │   ├── skills/
    │   ├── agents/
    │   └── mcp/
    ├── steps/                       # 步骤模板 YAML
    └── pipelines/                   # 流水线 YAML
```

---

## 十三、开发阶段规划

| 阶段 | 内容 | 预估 |
|------|------|------|
| **Phase 1: 基础框架** | 项目初始化、Express + React 骨架、SQLite、基础路由 | |
| **Phase 2: 资源管理** | ★ Skill/Agent/MCP CRUD、导入（Claude Code/本地/Git）、启用/禁用、YAML 加载 | |
| **Phase 3: 步骤管理** | 步骤模板 CRUD、YAML 加载、内置模板、步骤中引用资源 | |
| **Phase 4: 流水线编辑器** | 拖拽列表、流水线 CRUD、验证、资源选择器集成 | |
| **Phase 5: 会话引擎** | 会话 CRUD、预检引擎、流水线执行器、状态机、资源解析器 | |
| **Phase 6: Claude 集成** | Agent SDK 封装、流式输出、权限 Hook、Skill/MCP 运行时加载 | |
| **Phase 7: WebSocket** | 实时通信、状态推送、权限桥接 | |
| **Phase 8: 会话详情UI** | 步骤进度、对话面板、权限弹窗、输出查看 | |
| **Phase 9: 待处理项** | 收集、展示、处理、导出 | |
| **Phase 10: 会话恢复** | 中断恢复、重试、克隆 | |
| **Phase 11: 完善** | 预设流水线、UI 打磨、错误处理 | |

---

## 附录：关键设计决策速查

| # | 决策 | 选择 |
|---|------|------|
| 1 | 前端框架 | React + TypeScript + Vite |
| 2 | 后端框架 | Node.js + Express |
| 3 | Claude 集成 | Claude Agent SDK 为主 |
| 4 | 数据存储 | SQLite + 文件系统 |
| 5 | 步骤定义 | 纯 YAML 配置 |
| 6 | 流水线模型 | 线性序列 + 循环 |
| 7 | 上下文传递 | 自动累积 + 工作区文件 |
| 8 | 工作区策略 | AI 自行判断 |
| 9 | 中断恢复 | 从当前步骤开头重做 |
| 10 | 交互模式 | auto / confirm-each / auto-with-review |
| 11 | 权限桥接 | WebSocket + 后端白名单 |
| 12 | 预检策略 | 检测记录，步骤需要时强制 |
| 13 | 缺失工具 | 非阻塞记录，关键时等待安装 |
| 14 | 循环终止 | AI判断 / 固定次数 / 命令检查 |
| 15 | 资源管理 | Skill/Agent/MCP 项目级管理，步骤按需引用 |
| 16 | 资源来源 | builtin / claude-code / manual / import / git |
| 17 | Agent 定位 | 可选（不配用默认），有完整配置的 Claude 实例 |
| 18 | Skill 定位 | 可复用能力模块，可被步骤/Agent 直接调用 |
| 19 | MCP 定位 | 工具连接器，为步骤/Agent 提供外部工具 |
