# 用户气泡对比度修复 + 对话 `/` 命令 — 设计文档

日期：2026-10-19
状态：已确认（用户逐节批准）
前置：基于 `feature/llm-providers` 分支（含对话页/用量采集/主题系统）。

---

## 0. 需求总览

1. **白色主题下用户气泡文字不清晰**：用户消息气泡为 `colorPrimary` 蓝底，文字用了 `colorText`（浅色主题下近黑），对比度差。
2. **对话输入支持 `/` 命令**：`/compact` 压缩上下文、`/clear` 清理上下文、`/<skill名>` 引用已启用的 skill 资源。

已确认的关键决策：

| 决策点 | 选择 |
| --- | --- |
| `/clear` 语义 | 仅重置模型上下文；聊天记录保留可回看 |
| 命令分发架构 | A：服务端分发（POST /api/chat/:id/messages 统一入口） |
| `/compact` 实现 | 隐藏摘要轮：resume 当前 SDK 会话生成摘要 → 存库 → 重置会话句柄 → 下轮注入摘要 |

---

## 1. 用户气泡对比度修复（需求1）

`src/components/ChatMessages.tsx`：

- 用户气泡（`role === 'user'`）文字色：`token.colorText` → `token.colorTextLightSolid`（antd 语义 token，light/dark 两种算法下均为白色，专为彩色背景文字设计）。
- 用户气泡内时间戳行：`token.colorTextSecondary` → `rgba(255,255,255,0.8)`（仅用户气泡分支）。
- 助手/系统气泡与暗色主题观感不变。

验收：白色主题下蓝底白字清晰可读；暗色主题下用户气泡观感不退化。

## 2. 对话 `/` 命令（需求2）

### 2.1 命令解析（服务端分发）

- 入口：`POST /api/chat/:id/messages`，content 以 `/` 开头时进入命令分发（纯函数 `parseChatCommand(content)` 便于测试）：
  - `/clear`、`/compact` → 内置命令；
  - `/<name>` → 在已启用 skill 资源（`ResourceRepository.list({ type: 'skill', enabled: true })`）中按 `name` 精确匹配；
  - 均未命中 → 400「未知命令 /<name>，可用：/clear、/compact 或已启用的 skill」。
- 内置命令同样受现有 running 409 守卫约束（摘要轮执行期间再发任何消息 → 409）。
- 命令按首个空白截断 token；skill 名含空格将无法匹配（报未知命令），文档建议 skill 命名不带空格。
- 内置命令（/clear、/compact）的命令文本本身**不写**入 messages 表，仅插入系统结果消息；skill 命令属正常轮次，用户消息（含命令文本）照常入库（见 §2.4）。

### 2.2 内置命令（不走 LLM）

- **`/clear`**：
  - 清空 `chat_sdk_session_id` 与 `chat_summary`（`SessionRepository.resetChatContext(id)`），插入系统消息「🧹 上下文已清理，模型将重新开始（聊天记录保留）」，202 返回。
  - 聊天记录（messages 表）完全不动。
- **`/compact`**：
  - 无 `chat_sdk_session_id`（尚未对话）→ 插入系统消息「对话为空，无需压缩」，202 返回（不占 running）。
  - 有会话句柄 → 置 running 并广播 `status_change`，执行**隐藏摘要轮**：
    - 复用 `executeChatTurn`（resume 当前会话），prompt 为固定摘要指令（要求输出结构化对话摘要：任务目标、关键决定、未完成事项、后续所需上下文）；
    - `ChatTurnConfig` 新增 `disableTools?: boolean` → `sdkOptions.tools = []`（摘要轮禁工具，避免权限弹窗卡住）；
    - 累积 `ai_stream` 文本作为摘要；usage 照常落 `usage_records`；
    - 成功 → 摘要写入 `sessions.chat_summary`，清空 `chat_sdk_session_id`，插系统消息「📦 上下文已压缩（摘要 N 字），下轮对话将携带摘要」，status 回 idle；
    - 失败 → status error（复用现有状态机），插系统消息说明压缩失败可重试。
  - 摘要轮执行期间 runner 占用 controller map（与正常轮互斥，天然 409）。

### 2.3 摘要注入（下一轮对话）

`ChatTurnRunner.startTurn` 构建 prompt 时：

- 若 `session.chat_summary` 非空且 `chat_sdk_session_id` 为空 → prompt 前注入：

```
## Previous Conversation Summary
<summary>

（以上为此前对话的压缩摘要，请基于它继续。）
```

- 该轮拿到新 `sdk_session` 后清空 `chat_summary`（内容已烘进新会话，避免重复注入）。
- `applyFirstMessage` 不受影响（压缩后的会话 requirement 已非空）。

### 2.4 Skill 命令

- 命中 skill 后走正常 LLM 轮次：routes 层解析出 skill 的 `config.prompt`，经 `ChatTurnConfig` 新字段 `skillName?: string; skillPrompt?: string` 传入 runner；
- runner 组装 prompt 时在末尾追加（与 @引用的 Referenced Files 块并列）：

```
## Skill: <skillName>
<skillPrompt>
```

- 用户消息原样写入 messages 表并原样展示（命令本身可见）；bare 命令（无附加文字）也允许发送。

### 2.5 前端

- `ChatSession` 输入框 `Mentions` 的 `prefix` 改为 `['@', '/']`；通过 `onSearch(search, prefix)` 按触发前缀动态切换候选：
  - `'/'` → 内置命令两项（`clear` 清理上下文、`compact` 压缩上下文，带中文说明 label）+ 已启用 skill 列表（value=skill.name，label=名称+描述）；
  - `'@'` → 现有文件候选（不变）。
- 发送逻辑不变（服务端分发）；未知命令由 400 toast 提示。
- skill 列表复用 `GET /api/resources?type=skill&enabled=true`（页面加载时拉取一次）。

### 2.6 数据迁移与类型

- migration：`ALTER TABLE sessions ADD COLUMN chat_summary TEXT`（try/catch，沿用现有模式）。
- `SessionRepository.resetChatContext(id)`：清空 `chat_sdk_session_id`、`chat_summary` 两列。
- shared/types 无新增公开类型（命令为字符串约定；系统消息沿用现有 role='system'）。

### 2.7 测试

- `parseChatCommand` 纯函数：clear / compact / skill 命中 / 未知 / 非命令（不以 / 开头）。
- `/clear`：清句柄与摘要、系统消息插入、202；无句柄同样成功；running 中 409。
- `/compact`（伪 SDK）：无句柄 no-op + 系统消息；有句柄 → 摘要落库、句柄清空、系统消息、下轮 prompt 注入摘要块、新 sdk_session 后摘要清除；摘要轮失败 → status error + 系统消息。
- Skill：prompt 含 skill 块（skillName/skillPrompt 正确传递）；未知命令 400。
- `chat_summary` 迁移列存在且可读写（db-schema 测试惯例）。

### 2.8 不做的事（YAGNI）

- 不做自定义命令管理界面（skill 即命令，资源管理页已可维护）。
- 不做 `/compact` 自定义摘要指令参数。
- 不做命令历史/自动补全记忆。
- 不改流水线会话（命令仅对话页语义）。

## 3. 里程碑

1. 气泡对比度修复（独立可交付）。
2. 命令解析 + `/clear` + `/compact`（服务端）。
3. Skill 命令注入 + 前端 `/` 候选菜单。
4. 全量回归 + 手动验收（白色主题气泡、/clear、/compact 前后上下文衔接、/skill 注入、未知命令提示）。
