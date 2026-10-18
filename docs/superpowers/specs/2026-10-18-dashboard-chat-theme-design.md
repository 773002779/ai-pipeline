# 仪表盘统计、Claude 对话页、白色主题 — 设计文档

日期：2026-10-18
状态：已确认（用户逐节批准）
前置：基于 `feature/llm-providers` 分支（内置 Claude + LLM 供应商模块），最终与该分支一起合并。

---

## 0. 需求总览

1. **仪表盘优化**：真实数据替换静态假数据；展示近 N 天（可调）各模型 token 消耗量；展示 Top5 token 消耗会话。
2. **Claude 对话页**：实现 VSCode Claude 插件主要功能 —— 接近完整复刻档：核心多轮流式对话（含思考过程、工具权限确认、历史会话、随时停止）+ @文件引用 + 编辑 diff 预览。
3. **白色主题**：新增 light 主题并**设为默认**，保留 dark 主题可切换，选择持久化。

已确认的关键决策：

| 决策点 | 选择 |
| --- | --- |
| token 用量采集位置 | A1：SDK 侧（agent-manager 从 result/assistant 消息读取） |
| 对话页会话存储 | B1：复用 sessions 表 + 内置「自由对话」流水线 |
| 图表方案 | 引入 recharts（新增运行时依赖） |
| 对话页范围 | 接近完整复刻（核心对话 + @文件 + diff 预览） |

---

## 1. 白色主题（需求3）

### 1.1 主题上下文

- 新建 `src/theme/ThemeContext.tsx`：React Context 提供 `{ theme: 'light' | 'dark', setTheme }`。
- 持久化：localStorage key `app-theme`；**默认 `'light'`**；非法值按 light 处理。
- `main.tsx`：`ConfigProvider` 的 `algorithm` 按主题取 `theme.defaultAlgorithm`（light）或 `theme.darkAlgorithm`（dark）；`colorPrimary`、`borderRadius` 等 token 保持现状。

### 1.2 去硬编码

现有硬编码深色色值改为 antd 语义 token（`theme.useToken()`），dark 外观不变、light 正常：

- `Layout.tsx`：Header/Sider `#141414`、边框 `#303030`、Content `#1f1f1f` → `colorBgLayout`/`colorBgContainer`/`colorBorderSecondary`。
- `SessionDetail.tsx`：聊天区背景 `#1a1a1a`、气泡 `#262626`/`#333`、边框 `#333`、`ThinkingSection` 的 `#1a1a2e`/`#333366`/`#12121f` 等全部替换为语义 token（思考块可用 `colorFillSecondary`/`colorFillTertiary` + 紫色调跟随主题）。
- `OutputViewer`、`PermissionModal`、`ProviderManager` 等页面内联深色值一并清理。

### 1.3 切换与防闪烁

- Header 右上角切换按钮（太阳/月亮图标）。
- `index.html` `<head>` 内联小脚本：初始化时读取 `localStorage['app-theme']`，为 body 预设背景类（`theme-light`/`theme-dark`），避免刷新首帧闪色。

### 1.4 验收

- 默认首次打开为白色主题；切换 dark 后刷新保持；旧 dark 观感不退化。
- 主题切换不需要重启，所有页面无残留硬编码深色块。

---

## 2. 用量采集 + 仪表盘（需求1）

### 2.1 数据层：usage_records 表

```sql
CREATE TABLE usage_records (
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
);
CREATE INDEX idx_usage_created ON usage_records(created_at);
CREATE INDEX idx_usage_session ON usage_records(session_id);
```

- 用 `INTEGER` 记 token 数；不记成本（USD）：openai 协议供应商多数不返回价格，成本展示会系统性失真，YAGNI。
- cache 字段对 openai 协议供应商可能恒为 0（部分如 DeepSeek 返回 cache hit 会被 SDK 透传），允许为 0。

### 2.2 采集链路（A1）

- SDK `result` 消息带 `usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`；assistant 消息带 `message.model`。
- `agent-manager.extractMessageData` 扩展：提取 `usage` 与 `model`；事件流新增事件 `{ type: 'usage'; stepId; model; usage: {...} }`。
- `executor` 收到 `usage` 事件 → `UsageRepository.add(...)` 落库。
- 对话页（§3）走同一 `agent-manager`，自动统一采集；`step_id` 对 chat 会话为空。
- 局限说明：usage 在 SDK result 消息里，即一轮执行结束才产生一条记录；中途取消的轮次无 usage（可接受）。

### 2.3 统计 API（新 StatsRepository + /api/stats 路由）

- `GET /api/stats/overview`
  → `{ resources, pipelines, sessionsByStatus: {running, waitingConfirm, error, completed, ...}, sessionsTotal }`
  （替换仪表盘现有假数据卡）
- `GET /api/stats/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`
  → `{ models: [{model, inputTokens, outputTokens, cacheTokens, totalTokens}], daily: [{date, tokens}], topSessions: [{sessionId, name, kind: 'pipeline'|'chat', totalTokens}] }`
  - 缺省 `from` = 今天-6 天，`to` = 今天（近 7 天）；`created_at` 由 SQLite `datetime('now')` 写入为 UTC，过滤与按天分组统一用 `date(created_at, 'localtime')`（跟随操作系统时区，闭区间）。
  - `topSessions` 按区间内 totalTokens 降序取 5，含 chat 会话；`kind` 由 `pipeline_id === 'builtin-chat'` 判定。
  - 关联 `sessions.name` 作为展示名。

### 2.4 仪表盘 UI

- 统计卡（真实 overview 数据）。
- 时间范围选择：`Segmented`（今天 / 近7天 / 近30天 / 全部）+ `RangePicker` 自定义，**默认近 7 天**；切换即重新拉取。
- recharts 图表：
  - 每日 token 堆叠柱状图（按模型分色）；
  - 模型用量明细表（模型、input、output、cache、合计，降序）。
- Top5 会话列表：名称、类型 Tag（流水线/对话）、token 总量，点击跳转对应详情页。
- 空态：功能上线后才开始累积数据，无数据显示空态提示而非报错。

### 2.5 测试

- `UsageRepository` 增查；`agent-manager` 从伪 SDK 消息提取 usage/model（含缺省容错）。
- Stats 聚合：按模型汇总、按日分组、top5 排序与 kind 标记、日期边界（from/to 闭区间）。
- overview 计数正确性。

---

## 3. Claude 对话页（需求2）

### 3.1 会话模型（B1）

- 启动时（幂等）确保内置流水线存在：id 固定 `builtin-chat`，name「自由对话」，definition 为单占位步骤（不参与执行），不可在流水线列表编辑/删除（列表查询过滤 `builtin-chat`）。
- 每段对话 = `sessions` 表一行：`pipeline_id='builtin-chat'`，`name` = 首条用户消息前 20 字，`requirement` 存首条消息全文。
- sessions 表加两列（migration，try/catch ALTER）：
  - `chat_sdk_session_id TEXT`（SDK 会话句柄，首轮后写入，后续轮 resume 用）
  - `chat_model TEXT`（会话级模型覆盖，空 = 当前生效供应商默认模型）
- chat 会话 status 仅使用 `idle`（待输入）/`running`（生成中）/`error`（执行异常），多轮之间回到 idle；`currentStepIndex` 恒 0，`session_steps` 无行。
- 会话列表与详情按 `pipeline_id` 识别类型；流水线专属 UI（预检/步骤进度/克隆等）对 chat 会话隐藏。

### 3.2 执行模型（agent-manager 新增 chat 模式）

- 新方法 `executeChatTurn(config: ChatTurnConfig): AsyncGenerator<AgentEvent>`，与 `execute` 并存：
  - `persistSession: true`、`includePartialMessages: true`（文本 content_block_delta `text_delta` 逐 token 转发为 `ai_stream`，流水线模式维持现状不改）。
  - 首轮：`query({ prompt, options })`，从 SDK system/init 消息捕获 `session_id` 写回 `chat_sdk_session_id`。
  - 后续轮：`options.resume = chat_sdk_session_id`。
  - prompt = 用户消息；若解析出 @引用，末尾附「## Referenced Files」块（见 3.4）。
  - 模型：`chat_model` 优先，否则当前生效供应商默认（路由层传 `defaultModel`，与流水线一致）。
  - 环境注入（ANTHROPIC_BASE_URL/TOKEN/CLAUDE_CONFIG_DIR、git-bash 探测）与流水线共用 `buildSdkOptions` 提取出的公共部分；`cwd` = chat 会话选择的工作目录（见 3.6）。
  - 工具：不设白名单（CLI 默认全量），权限确认走现有 `canUseTool` → WS 流程；`permission_whitelist` 按 session_id 天然隔离。
- **API**（新 `server/routes/chat.ts`）：
  - `POST /api/chat/:sessionId/messages` `{content}` → 写入 user 消息、启动该轮执行（后台异步），立即 202 返回；流式经 WS 推送（复用 `ai_message`/`thinking_delta`/`tool_use`/`permission_request`）。
  - 轮次执行器（chat 侧消费 AgentEvent 的角色，对标流水线 executor）：转发 WS 事件、将本轮 assistant 回复（含 thinking）写入 `messages` 表、收到 `usage` 事件落 `usage_records`（`step_id` 为空）、轮末 status 回 `idle`。
  - `POST /api/chat/:sessionId/stop` → AbortController 中断当前轮；status 回 idle；已生成部分照常落库。
  - `GET /api/fs/tree?root=<绝对路径>` → 工作目录文件树（见 3.4）。
  - 创建会话 `POST /api/chat/sessions` `{name?, workspaces, model?}`（封装内置流水线 id），也可直接复用 sessions 路由 + 前端传 `builtin-chat`；采用前者，语义清晰。
- 执行期间再次发消息：409「当前回复生成中」。

### 3.3 消息与 UI 复用

- 消息沿用 `messages` 表（`step_id` 空）；前端从 `SessionDetail` 抽出共享组件 `ChatMessages`（消息气泡 + `ThinkingSection`），流水线会话详情与新对话页共用，`SessionDetail` 相应瘦身。
- 对话页布局：左侧会话历史列表（新建对话、切换、删除单条对话 = sessions 删除级联消息）；右侧消息流 + 底部输入框（@引用、Enter 发送 / Shift+Enter 换行）+ 顶部模型选择与停止按钮。
- 模型选择为**会话级**：顶部下拉变更即更新该会话的 `chat_model`，对后续轮次生效（已生成的历史轮不变）。
- 路由：`/chat`（列表）与 `/chat/:id`（对话页）；侧边菜单加「Claude 对话」。
- 前置校验：无生效供应商时发起对话返回 400（与流水线 start 一致文案）。

### 3.4 @文件引用

- 后端 `GET /api/fs/tree?root=`：递归列出文件（含目录结构）；忽略 `node_modules`、`.git`、`dist` 等目录与二进制/超大文件；深度上限 8、条目上限 2000；`root` 必须为已存在目录，否则 400。
- 前端输入框输入 `@` 触发 antd `Mentions` 组件模糊搜索（按相对路径匹配），选中插入 `@相对/路径` 文本。
- 服务端发送前解析消息中的 `@path` token：
  - `path.resolve(root, rel)` 后强制前缀校验在工作目录内（防 `../` 逃逸）；
  - 校验文件存在；不存在的引用原样保留文本并忽略；
  - 命中的文件在 prompt 末尾附 `## Referenced Files\n- <绝对路径>`（由 Claude 自行 Read）。

### 3.5 Diff 预览（编辑审批）

- `canUseTool` 拦截 `Edit`/`Write`/`NotebookEdit`：
  - `Edit`：读磁盘原文件 + `old_string`/`new_string`（及 `replace_all`）构造"应用后全文"；
  - `Write`：原文件内容 vs `content`；
  - `NotebookEdit`：按 JSON 单元格文本近似处理（首版：整体替换 diff）。
- 服务端自写行级 LCS diff 工具（~60 行，无新依赖），产出 `diffLines: {type: 'ctx'|'add'|'del', text}[]`。
- `permission_request` 事件增加可选 `diff: {path, oldContent, newContent, diffLines}` 字段（shared 类型同步）；`PermissionModal` 有 diff 时渲染红绿行视图，标题按工具显示「编辑文件确认」，按钮逻辑（批准/拒绝/加白名单）不变。
- 读文件失败（如新文件）时 oldContent 为空字符串，diff 全绿。

### 3.6 工作目录

- 对话页创建会话时选择 1 个工作目录（复用 Workspace 结构，`type='unknown'`）；会话内不可改（重建对话即可）。
- `cwd` 传该目录；`additionalDirectories` 不用。

### 3.7 测试

- chat 轮次：伪 SDK 验证首轮 query / 后续 resume / session_id 回写 / stop 中断 / running 中重复发送 409。
- @解析：命中、逃逸拒绝（`../`）、不存在忽略、注入 Referenced Files 块。
- `/api/fs/tree`：忽略目录、深度/条目上限、非法 root 400。
- diff 构造：Edit（含 replace_all）、Write 覆盖、新文件全绿。
- 内置流水线幂等创建、流水线列表过滤 builtin-chat。
- usage 落库 + stats 聚合（§2.5）。
- 主题：Context 默认 light、切换持久化（客户端测试）。
- 全局约束：TDD；基线 134 测试全绿；`tsc` 无错；除 recharts 外不新增运行时依赖。

---

## 4. 不做的事（YAGNI 边界）

- 不做成本（USD）统计展示。
- 不做对话内容向量检索/全文搜索。
- 不做 subagent 任务列表展示、plan mode、记忆文件管理（SDK 未直接暴露，且非"主要功能"核心闭环）。
- 不改流水线模式的流式粒度（整块推送维持现状）。
- 不做移动端适配。

## 5. 里程碑

1. 主题系统（§1）— 独立可交付。
2. 用量采集 + stats API + 仪表盘（§2）。
3. 对话页后端（内置流水线、chat 执行模式、chat API、fs/tree、diff 构造）。
4. 对话页前端（/chat 路由、ChatMessages 抽取、@引用、diff 弹窗、模型选择）。
5. 联调收尾：全量测试、tsc、build、手动验收清单。
