// ============================================================
// 共享类型定义 — AI Pipeline
// ============================================================

// 内置「自由对话」流水线 id（Claude 对话页专用）
export const BUILTIN_CHAT_PIPELINE_ID = 'builtin-chat';

// ---- 资源 (Resource) ----

export type ResourceType = 'skill' | 'agent' | 'mcp';
export type ResourceSource = 'builtin' | 'claude-code' | 'manual' | 'import' | 'git';

export interface SkillConfig {
  prompt: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tools?: string[];
}

export interface AgentConfig {
  systemPrompt: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
  mcpServerIds?: string[];
  skillIds?: string[];
  temperature?: number;
}

export interface McpConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoApprove?: string[];
}

export type ResourceConfig = SkillConfig | AgentConfig | McpConfig;

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version: string;
  source: ResourceSource;
  sourcePath?: string;
  config: ResourceConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- 步骤模板 (StepTemplate) ----

export type InteractionMode = 'auto' | 'confirm-each' | 'auto-with-review';
export type LoopTerminationMode = 'ai-judge' | 'fixed' | 'until-pass';

export interface LoopConfig {
  maxIterations: number;
  terminationMode: LoopTerminationMode;
  terminationPrompt?: string;
  checkCommand?: string;
}

export interface ResourceOverrides {
  agent?: {
    model?: string;
    maxTokens?: number;
  };
  skills?: Record<string, { inputParams?: Record<string, unknown> }>;
  mcpServers?: Record<string, { env?: Record<string, string> }>;
}

export interface StepTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  systemPrompt: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
  agentId?: string;
  skillIds?: string[];
  mcpServerIds?: string[];
  resourceOverrides?: ResourceOverrides;
  interactionMode: InteractionMode;
  autoAdvance: boolean;
  pauseForQuestions: boolean;
  collectActionItems: boolean;
  loopEnabled: boolean;
  defaultLoopConfig?: LoopConfig;
  inputSchema?: Record<string, unknown>;
  outputFormat: 'markdown' | 'json' | 'text';
  outputTemplate?: string;
}

// ---- 流水线 (Pipeline) ----

export interface PipelineStepConfig {
  id: string;
  templateId: string;
  order: number;
  overrides?: {
    systemPrompt?: string;
    model?: string;
    interactionMode?: string;
    loopConfig?: LoopConfig;
  };
  condition?: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStepConfig[];
  createdAt: string;
  updatedAt: string;
}

// ---- 会话 (Session) ----

export type SessionStatus =
  | 'idle'
  | 'precheck'
  | 'running'
  | 'waiting_confirm'
  | 'paused'
  | 'error'
  | 'completed'
  | 'cancelled';

export type WorkspaceType = 'frontend' | 'backend' | 'fullstack' | 'library' | 'unknown';

export interface Workspace {
  name: string;
  path: string;
  type: WorkspaceType;
}

export interface WorkspaceEnv {
  name: string;
  path: string;
  techStack: string[];
  dependencies?: Record<string, string>;
}

export interface EnvironmentContext {
  workspaces: WorkspaceEnv[];
  availableTools: string[];
  missingButNeeded: string[];
  detectedAt: string;
}

export type SessionStepStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped';

export interface SessionStep {
  templateId: string;
  stepName: string;
  status: SessionStepStatus;
  startedAt?: string;
  completedAt?: string;
  outputPath?: string;
  errorMessage?: string;
  retryCount: number;
}

export interface Session {
  id: string;
  pipelineId: string;
  pipelineSnapshot: Pipeline;
  name: string;
  requirement: string;
  status: SessionStatus;
  workspaces: Workspace[];
  environment?: EnvironmentContext;
  currentStepIndex: number;
  steps: SessionStep[];
  stepOverrides?: Record<string, PipelineStepConfig['overrides']>;
  chatSdkSessionId?: string;   // Claude 对话：SDK 会话句柄（多轮 resume）
  chatModel?: string;          // Claude 对话：会话级模型覆盖
  createdAt: string;
  updatedAt: string;
}

// ---- 待处理项 (ActionItem) ----

export type ActionItemSeverity = 'error' | 'warning' | 'suggestion' | 'question';
export type ActionItemStatus = 'pending' | 'accepted' | 'rejected' | 'deferred';

export interface ActionItem {
  id: string;
  sessionId: string;
  stepId: string;
  severity: ActionItemSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  status: ActionItemStatus;
  resolution?: string;
  createdAt: string;
}

// ---- 权限确认 (PermissionRequest) ----

export type PermissionRisk = 'low' | 'medium' | 'high';
export type PermissionStatus = 'pending' | 'approved' | 'denied';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  message: string;
  risk: PermissionRisk;
  timestamp: string;
  status: PermissionStatus;
}

// ---- 对话消息 (Message) ----

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  sessionId: string;
  stepId?: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  toolCalls?: Record<string, unknown>;
  createdAt: string;
}

// ---- WebSocket 事件 ----

export type WsServerEvent =
  | { type: 'status_change'; data: { status: SessionStatus; currentStepIndex: number } }
  | { type: 'step_progress'; data: { stepName: string; progress: number; currentAction: string } }
  | { type: 'ai_message'; data: { content: string; done: boolean; stepId?: string } }
  | { type: 'thinking_delta'; data: { content: string; done: boolean; stepId?: string } }
  | { type: 'permission_request'; data: PermissionRequest }
  | { type: 'tool_use'; data: { toolName: string; input: Record<string, unknown> } }
  | { type: 'action_item'; data: ActionItem }
  | { type: 'step_complete'; data: { stepId: string; outputPath: string } };

export type WsClientEvent =
  | { type: 'chat_message'; data: { content: string } }
  | { type: 'permission_response'; data: { reqId: string; action: 'approve' | 'deny' | 'whitelist' } }
  | { type: 'step_response'; data: { stepId: string; content: string } };

// ---- API 响应 ----

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

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
