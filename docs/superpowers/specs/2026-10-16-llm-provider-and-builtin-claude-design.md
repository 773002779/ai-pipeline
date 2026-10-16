# 内置 Claude 与多供应商大模型接入 — 设计文档

> 日期: 2026-10-16 | 状态: 已确认

## 一、背景与目标

当前 ai-pipeline 的步骤执行依赖本地 Claude 环境：鉴权读 `~/.claude` 登录态或 `ANTHROPIC_API_KEY` 环境变量，配置读写 `~/.claude`，模型地址不可配置。同时 Agent SDK 只支持 Anthropic Messages 协议，无法使用 OpenAI chat 协议的模型服务（DeepSeek、通义、GLM、one-api 聚合等）。

**目标：**

1. **开箱即用 + 配置隔离**：目标机器只需 Node.js——无需全局安装 Claude Code CLI、无需 `claude login`、不读写 `~/.claude`；鉴权与模型信息全部在 Web UI 配置。
2. **大模型配置模块**：支持配置多个供应商，其中一个"当前生效"，编码（流水线步骤执行）统一使用它。
3. **双协议支持**：OpenAI chat 协议供应商在进程内做 Anthropic↔OpenAI 转换；Anthropic 协议供应商直接透传。
4. **Continue 配置导入**：可从 Continue.dev 的 `config.yaml` 一键导入供应商配置。
5. **运维脚本**：`start.bat` / `stop.bat` / `restart.bat`，生产模式单进程。

**非目标（本期不做）：**

- 步骤/流水线级供应商指定（`model` 覆盖字段仅在当前供应商下切换模型名）。
- 嵌入（embedding）、补全（autocomplete）类模型角色。
- API Key 加密存储（本地单机工具，明文存 `.pipeline/data.db`，文档注明）。
- 权限白名单、循环执行等既有功能缺口（另行处理）。

## 二、总体架构

```
┌──────────────────────────── Node 服务 (3001, 单进程) ────────────────────────────┐
│                                                                                  │
│  Express API                        LLM 转换代理 (server/llm/)                    │
│  ├─ /api/providers (新)             挂载路径: /_llm  (由内部令牌防外部误调)          │
│  ├─ /api/sessions ...               └─ POST /v1/messages                          │
│  └─ 静态托管 dist/ (生产)            ├─ translate-request (Anthropic→OpenAI 请求)  │
│                                     ├─ translate-request (Anthropic→OpenAI 请求)  │
│  PipelineExecutor                   ├─ translate-stream  (OpenAI SSE→Anthropic)   │
│   └─ ClaudeAgentManager             └─ passthrough       (Anthropic 协议透传)      │
│       └─ buildSdkOptions() 注入 env                                              │
│           ANTHROPIC_BASE_URL = http://127.0.0.1:3001/_llm                        │
│           ANTHROPIC_AUTH_TOKEN = <随机内部令牌>                                    │
│           ANTHROPIC_MODEL = <生效供应商模型 或 模板覆盖>                             │
│           CLAUDE_CONFIG_DIR = <项目>/.pipeline/claude-config                      │
└──────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼ (按当前生效供应商转发)
                        ┌──────────────────────────────┐
                        │ OpenAI 协议: /chat/completions│  ← 进程内转换
                        │ Anthropic 协议: /v1/messages  │  ← 透传
                        └──────────────────────────────┘
```

关键决策：**复用主 HTTP server 挂载代理路径**（不第二个端口、不第二个进程）；转换层拆为纯函数/状态机模块，保证可单测。

## 三、数据模型

新表 `providers`：

```sql
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                     -- 显示名，如 "DeepSeek 官方"
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,                 -- 如 https://api.deepseek.com（不含 /v1，代码拼接）
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,                    -- 默认模型名，如 deepseek-chat
  temperature REAL,
  max_tokens INTEGER,
  is_active INTEGER NOT NULL DEFAULT 0,   -- 单激活：激活新的自动取消旧的
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'continue')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

配套 `ProviderRepository`（沿用现有仓储模式）与 schema 迁移（createTables 追加，catch 已存在）。

**模型名解析优先级**（执行时）：步骤 overrides.model / 步骤模板 model（视为当前供应商下的模型名）→ 当前生效供应商的 `model` 字段。

## 四、REST API 设计

```
GET    /api/providers                    # 列表（api_key 脱敏返回：仅返回后4位 + hasKey 标记）
POST   /api/providers                    # 创建 {name, protocol, baseUrl, apiKey, model, temperature?, maxTokens?}
PUT    /api/providers/:id                # 更新（apiKey 缺省表示不修改）
DELETE /api/providers/:id                # 删除
POST   /api/providers/:id/activate       # 激活（事务内先清零其他）
POST   /api/providers/:id/test           # 连通性测试：按配置发一个小请求，返回 {ok, latencyMs, error?}
POST   /api/providers/import-continue    # { configPath } 或 { content } → 解析 Continue config.yaml 并导入，返回导入清单
```

错误约定：无激活供应商时执行步骤，`start` 路由返回 400 `{error: '未配置生效的大模型供应商，请在「模型配置」页激活'}`，并通过 WS 推送 `status_change(error)` 与消息。

## 五、转换代理

### 5.1 挂载与安全

- Express 路径 `/_llm`，仅接受 SDK 的 `/v1/messages`（POST，流式/非流式）。
- 校验 `Authorization`/`x-api-key` 头等于进程启动时生成的内部随机令牌，否则 401——防止浏览器侧误调/外网穿透直连。
- 代理按"当前生效供应商"转发；供应商被删除/切换时，已进行中的请求按原配置走完。

### 5.2 请求转换（Anthropic Messages → OpenAI Chat Completions，纯函数）

| Anthropic | OpenAI |
|---|---|
| `system`（string 或 blocks） | messages[0] `{role:'system'}` |
| `messages[].content` text 块 | 同角色消息的文本拼接 |
| assistant 消息中的 `tool_use` 块 | `tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` |
| user 消息中的 `tool_result` 块 | `{role:'tool', tool_call_id, content}`（多个 tool_result 拆多条 tool 消息） |
| `tools[].{name, description, input_schema}` | `tools[].{type:'function', function:{name, description, parameters}}` |
| `max_tokens` | `max_tokens` |
| `temperature` / `stop_sequences` | `temperature` / `stop` |
| `tool_choice` | `tool_choice`（auto/any→required/具体工具→{type:'function', function:{name}}） |
| `cache_control`、`thinking`、`metadata` | 剥离 |

### 5.3 流式响应转换（OpenAI SSE → Anthropic SSE，状态机）

状态机维护：当前开启的 content block（text / thinking / tool_use×N）、工具调用增量聚合表（按 index 聚合 id/name/arguments 分片）、usage 累计。

| OpenAI 流事件 | Anthropic 事件 |
|---|---|
| 首个 chunk | `message_start`（含 usage）→ `content_block_start(text)` |
| `delta.content` | `content_block_delta(text_delta)` |
| `delta.reasoning_content`（R1 类推理模型） | 切换到 thinking 块 → `content_block_delta(thinking_delta)`；回到正文时先 stop 再重开 text 块 |
| `delta.tool_calls[i]`（首片） | text/thinking 块 stop → `content_block_start(tool_use, index=i)` |
| `delta.tool_calls[i].function.arguments` 后续片 | `input_json_delta` |
| `finish_reason`: stop / tool_calls / length | `content_block_stop` → `message_delta`(end_turn / tool_use / max_tokens, usage) → `message_stop` |
| `data: [DONE]` | 兜底收尾（若上游未发 finish_reason） |

非流式请求（`stream:false`）：一次性转换整个响应为 Anthropic Messages 响应体（不走状态机）。Anthropic 透传分支：改写目标 URL 与鉴权头后请求/响应体原样 pipe（支持流式），**不修改请求体**——供应商的 temperature/max_tokens 仅在 OpenAI 转换路径生效（透传时 SDK 请求体已自带这些参数，代理不越俎代庖）。

## 六、内置 Claude 与环境隔离

1. CLI 使用 SDK 自带 `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`——零安装。
2. `buildSdkOptions()` 注入上述四个环境变量；内部令牌进程启动时生成一次。
3. `CLAUDE_CONFIG_DIR` 指向 `.pipeline/claude-config`，启动时确保目录存在——完全不触碰 `~/.claude`。
4. **启动自检**（结果打印进启动横幅并合入 `/api/health`）：
   - `cli.js` 存在；
   - Windows：git-bash 可定位（先 `CLAUDE_CODE_GIT_BASH_PATH` 环境变量 → 常见路径探测 → `where bash`）；找不到时横幅给出明确提示（含安装建议），执行时报错引导；
   - 是否存在激活供应商（仅警告，不阻断启动）。
5. 离线性：SDK BASE_URL 指向本地代理，程序本身**不再硬编码依赖任何 Anthropic 官方域名**；请求只发往用户配置的 baseUrl（用户明确配置官方 API 时才访问它）。

## 七、前端「模型配置」页

- 路由 `/providers`，Layout 菜单新增「模型配置」。
- 供应商卡片列表：名称、协议标签、baseUrl、默认模型、生效高亮（Active 标记）、操作（编辑/测试/激活/删除）。
- 新建/编辑表单：名称、协议下拉（OpenAI 协议 / Anthropic 协议）、base_url、api_key（密码框，编辑时留空不改）、默认模型、temperature/max_tokens（高级折叠）。
- 「测试」按钮显示延迟或错误信息；「从 Continue 导入」对话框：输入 config.yaml 路径（默认探测 `%USERPROFILE%/.continue/config.yaml`），预览解析出的供应商清单后确认导入。
- 会话详情页：无激活供应商导致的失败要能从错误消息与 WS 推送中看到明确引导文案。

## 八、运维脚本（生产模式单进程）

前提改造：`app.ts` 增加静态托管——`NODE_ENV=production` 时 `express.static(dist)` + SPA fallback（非 `/api`、非 `/_llm`、非 `/ws` 的 GET 回 `index.html`）。开发模式行为不变（Vite 5173 代理）。

| 脚本 | 行为 |
|---|---|
| `start.bat` | `%~dp0` 定位项目；`dist` 缺失则 `npm run build`；检测 3001 端口被占用则提示已运行并退出；`npx tsx server/index.ts` 启动（`NODE_ENV=production`），启动后打开浏览器 `http://localhost:3001` |
| `stop.bat` | `netstat -ano | findstr :3001` 取 PID → `taskkill /F /PID`；无监听则提示未运行 |
| `restart.bat` | 依次调用 stop、start |

统一 `@echo off` + `chcp 65001`（中文输出不乱码）。stop 采用强杀（进程内 sql.js 有 5 秒级定时落盘，强杀最多丢最近 5 秒运行时状态，与现状一致）。

## 九、错误处理

- **无激活供应商**：start 路由 400 + WS 引导文案（见四）。
- **上游 401/404/429/5xx**：代理转换响应为 Anthropic 错误事件格式透传语义；SDK 侧表现为 step_error，消息保留上游状态码与摘要。
- **上游流中断**：状态机发 `message_stop` 兜底并结束请求，executor 记录错误。
- **连通性测试**：`/test` 对 openai 协议发 1 token 的 chat 请求、anthropic 协议发最小 messages 请求；超时 10s。
- **git-bash 缺失**：启动警告 + 执行时明确报错（Windows only）。

## 十、测试策略

| 模块 | 方式 |
|---|---|
| translate-request | 纯函数单测：system/text/tool_use/tool_result/tools/参数映射/剥离项 |
| translate-stream | 状态机单测（喂固定 OpenAI SSE 序列断言 Anthropic 事件序列）：纯文本流、工具调用流、reasoning 交替、混合、[DONE] 兜底 |
| proxy | 内存 express + mock 上游（返回固定 SSE）集成测试：openai 转换路径、anthropic 透传路径、内部令牌 401 |
| providers 路由 | 沿用现有路由测试模式（内存库 + 随机端口）：CRUD、激活唯一性、导入 |
| continue-import | 样例 config.yaml 解析测试：多模型、协议推断、角色过滤（只导入 chat 类） |
| 启动自检/静态托管 | 单测：health 汇总、SPA fallback 不吞 /api |
| bat | 手动验证清单写入实施计划（start 幂等、stop 干净、restart 往返） |

现有 81 个测试全程保持绿。

## 十一、里程碑划分（供实施计划参考）

1. providers 数据层 + REST + 测试（无 UI）
2. 转换层纯函数 + 流状态机 + 测试（核心，独立可交付）
3. 代理挂载 + SDK env 注入 + 启动自检（打通一次真实执行）
4. 前端模型配置页 + Continue 导入
5. app.ts 静态托管 + 三个 bat + 手动验证
