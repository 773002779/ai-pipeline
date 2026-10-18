/**
 * Claude Agent Manager —— 封装 Claude Agent SDK 调用
 *
 * SDK 核心 API:
 * - query({ prompt, options }) → AsyncGenerator<SDKMessage>
 * - Options.canUseTool → 权限回调 (Permission Hook)
 * - Options.tools → 工具白名单
 * - Options.model → 模型选择
 * - Options.cwd → 工作目录
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config as appConfig } from '../config';
import { getInternalToken } from '../llm/internal-token';
import type { SessionChannel } from '../ws/session-channel';
import { waitForPermission } from '../ws/permission-store';
import { buildToolDiff } from '../utils/tool-diff';
import type { StepTemplate, Resource, Workspace } from '../../shared/types';

// On Windows, the SDK CLI requires git-bash — common install locations
const GIT_BASH_CANDIDATES = [
  'D:\\develop\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
];

export interface AgentCallConfig {
  sessionId: string;
  stepId: string;
  template: StepTemplate;
  resolvedAgent?: Resource | null;
  resolvedSkills: Resource[];
  resolvedMcps: Resource[];
  workspaces: Workspace[];
  previousOutputs: Array<{ stepName: string; summary: string; path: string }>;
  requirement: string;
  environment?: Record<string, unknown>;
  defaultModel?: string;   // 当前生效供应商的默认模型名（路由层传入）
  wsChannel: SessionChannel;
}

export class ClaudeAgentManager {
  /**
   * Execute a step using the Claude Agent SDK.
   * Returns an async generator that yields execution events.
   */
  async *execute(config: AgentCallConfig): AsyncGenerator<AgentEvent> {
    const { sessionId, stepId, template } = config;

    yield { type: 'step_start', stepId, timestamp: new Date().toISOString() };

    try {
      // Build the system prompt by merging template + resources
      const systemPrompt = this.buildSystemPrompt(config);

      // Build SDK options (tools, model, MCP servers, permission hook, env)
      const sdkOptions = this.buildSdkOptions(config);

      yield {
        type: 'agent_config',
        stepId,
        data: {
          model: (sdkOptions.model as string) || '(CLI default)',
          tools: Array.isArray(sdkOptions.tools) ? (sdkOptions.tools as unknown[]).length : 0,
          mcpServers: sdkOptions.mcpServers ? Object.keys(sdkOptions.mcpServers as object) : [],
          cwd: sdkOptions.cwd,
        },
      };

      // Actually call the SDK
      // NOTE: Dynamic import because the SDK is ESM-only
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const q = query({
        prompt: systemPrompt,
        options: sdkOptions,
      });

      let tokenCount = 0;
      let lastModel: string | undefined;

      for await (const message of q) {
        // Handle streaming events (thinking deltas from extended thinking)
        if (message.type === 'stream_event') {
          const event = (message as any).event;
          if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
            yield {
              type: 'thinking_stream',
              stepId,
              content: event.delta.thinking || '',
              done: false,
            };
            continue;
          }
          if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
            yield {
              type: 'thinking_stream',
              stepId,
              content: event.content_block.thinking || '',
              done: false,
            };
            continue;
          }
          continue;
        }

        // Extract message content
        const msgData = this.extractMessageData(message);

        if (msgData.type === 'assistant') {
          if (msgData.model) lastModel = msgData.model;
          if (msgData.thinking) {
            yield {
              type: 'thinking_stream',
              stepId,
              content: msgData.thinking,
              done: true,
            };
          }
          if (msgData.content) {
            tokenCount++;
            yield {
              type: 'ai_stream',
              stepId,
              content: msgData.content,
              done: false,
              tokens: tokenCount,
            };
          }
        }

        if (msgData.type === 'tool_use') {
          yield {
            type: 'tool_use',
            stepId,
            toolName: msgData.toolName || 'unknown',
            input: msgData.toolInput || {},
          };
        }

        if (msgData.type === 'result') {
          yield {
            type: 'thinking_stream',
            stepId,
            content: '',
            done: true,
          };
          yield {
            type: 'ai_stream',
            stepId,
            content: msgData.content || '',
            done: true,
            tokens: tokenCount,
          };

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
        }
      }

      yield {
        type: 'step_complete',
        stepId,
        output: `Step completed. Tokens used: ${tokenCount}`,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      yield {
        type: 'step_error',
        stepId,
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
      };
    }
  }

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

  /**
   * Build the SDK query options: cwd, tools, model, MCP servers,
   * permission hook and platform env.
   */
  buildSdkOptions(config: AgentCallConfig): Record<string, unknown> {
    const env = this.buildEnv();

    const sdkOptions: Record<string, unknown> = {
      cwd: config.workspaces[0]?.path || process.cwd(),
      // Additional directories for multi-workspace
      additionalDirectories: config.workspaces.slice(1).map(w => w.path),
      // Permission hook: bridges to WebSocket for user confirmation
      canUseTool: this.createPermissionHook(config.wsChannel, config.sessionId),
      // Pass env with git-bash path on Windows
      env,
      // Disable persistence for cleaner execution
      persistSession: false,
    };

    // Set tools if explicitly configured, otherwise let CLI use its defaults
    const tools = this.buildToolsList(config);
    if (tools.length > 0) {
      sdkOptions.tools = tools;
    }

    // Resolve model: template override → agent config → active provider default
    const resolvedModel =
      config.template.model ||
      (config.resolvedAgent?.config as { model?: string })?.model ||
      config.defaultModel ||
      undefined; // 都没有则交给 CLI 默认
    if (resolvedModel) {
      sdkOptions.model = resolvedModel;
    }

    // Only set maxThinkingTokens if template explicitly requests it
    // (DeepSeek & other proxies may not support extended thinking)
    if (config.template.maxTokens && config.template.maxTokens > 0) {
      sdkOptions.maxThinkingTokens = config.template.maxTokens;
    }

    // MCP servers referenced by the step
    const mcpServers = this.buildMcpServers(config);
    if (Object.keys(mcpServers).length > 0) {
      sdkOptions.mcpServers = mcpServers;
    }

    return sdkOptions;
  }

  /**
   * Build the merged system prompt from template + resources
   */
  private buildSystemPrompt(config: AgentCallConfig): string {
    const parts: string[] = [];

    // 1. Agent system prompt (if configured)
    if (config.resolvedAgent) {
      const agentConfig = config.resolvedAgent.config as any;
      if (agentConfig.systemPrompt) {
        parts.push(`## Agent Role\n${agentConfig.systemPrompt}`);
      }
    }

    // 2. Step template system prompt
    parts.push(`## Task\n${config.template.systemPrompt}`);

    // 3. Context: requirement
    parts.push(`## Project Requirement\n${config.requirement}`);

    // 4. Context: previous outputs
    if (config.previousOutputs.length > 0) {
      parts.push('## Previous Step Outputs');
      for (const prev of config.previousOutputs) {
        parts.push(`### ${prev.stepName}\nSummary: ${prev.summary}\nOutput: ${prev.path}`);
      }
    }

    // 5. Context: workspaces
    parts.push('## Workspaces');
    for (const ws of config.workspaces) {
      parts.push(`- ${ws.name} (${ws.type}): ${ws.path}`);
    }

    // 6. Context: environment
    if (config.environment) {
      parts.push(`## Environment\n${JSON.stringify(config.environment, null, 2)}`);
    }

    // 7. Skill prompts (injected)
    for (const skill of config.resolvedSkills) {
      const skillConfig = skill.config as any;
      if (skillConfig.prompt) {
        parts.push(`## Skill: ${skill.name}\n${skillConfig.prompt}`);
      }
    }

    // 8. Output format instruction
    parts.push(`## Output Format
Please produce output in ${config.template.outputFormat} format.
${config.template.outputTemplate || 'Provide a clear, structured output document.'}`);

    // 9. Interaction mode instructions
    if (config.template.interactionMode === 'auto-with-review') {
      parts.push(`\n## Action Items
If you find issues, bugs, or suggestions, record them as action items with severity (error/warning/suggestion).`);
    }

    return parts.join('\n\n');
  }

  /**
   * Build the combined tools list from template + agent + skills + MCPs
   */
  private buildToolsList(config: AgentCallConfig): string[] {
    const tools = new Set<string>();

    // Template tools
    for (const t of config.template.tools || []) {
      tools.add(t);
    }

    // Agent tools
    if (config.resolvedAgent) {
      const agentConfig = config.resolvedAgent.config as any;
      for (const t of agentConfig.tools || []) {
        tools.add(t);
      }
    }

    return Array.from(tools);
  }

  /**
   * Build MCP server configurations
   */
  private buildMcpServers(config: AgentCallConfig): Record<string, unknown> {
    const servers: Record<string, unknown> = {};

    for (const mcp of config.resolvedMcps) {
      const mcpConfig = mcp.config as any;
      if (mcpConfig.command) {
        servers[mcp.name] = {
          type: 'stdio',
          command: mcpConfig.command,
          args: mcpConfig.args || [],
          env: mcpConfig.env || {},
        };
      } else if (mcpConfig.url) {
        servers[mcp.name] = {
          type: 'sse',
          url: mcpConfig.url,
        };
      }
    }

    return servers;
  }

  /**
   * Create permission hook that bridges to WebSocket
   */
  private createPermissionHook(wsChannel: SessionChannel, sessionId: string): CanUseTool {
    return async (toolName: string, input: Record<string, unknown>, options: {
      signal: AbortSignal;
      suggestions?: any[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
    }): Promise<PermissionResult> => {
      const permId = uuidv4();
      const diff = buildToolDiff(toolName, input);

      // Send permission request to frontend
      wsChannel.broadcastToSession(sessionId, {
        type: 'permission_request',
        data: {
          id: permId,
          sessionId,
          toolName,
          toolInput: input,
          message: `Claude wants to use "${toolName}": ${options.decisionReason || 'No reason provided'}`,
          risk: this.assessRisk(toolName, input),
          timestamp: new Date().toISOString(),
          status: 'pending',
          ...(diff ? { diff } : {}),
        },
      });

      // Wait for user response via the shared permission store.
      // The abort signal denies immediately (e.g. session cancelled).
      return waitForPermission(permId, sessionId, 300_000, options.signal);
    };
  }

  private assessRisk(toolName: string, input: Record<string, unknown>): 'low' | 'medium' | 'high' {
    // High risk operations
    const highRiskCommands = ['rm -rf', 'sudo', 'chmod 777', '> /dev/', 'format'];
    const command = (input.command || input.cmd || '') as string;

    if (toolName === 'Bash' && highRiskCommands.some(c => command.includes(c))) {
      return 'high';
    }

    if (['Write', 'Edit', 'Bash'].includes(toolName)) {
      return 'medium';
    }

    return 'low';
  }

  private extractMessageData(message: Record<string, unknown>): {
    type: string;
    content?: string;
    thinking?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    model?: string;
    usage?: Record<string, number>;
  } {
    // SDK Messages can be various types; extract the common fields
    const msg = message as any;
    const model = (msg.message?.model || msg.model) as string | undefined;
    const usage = (msg.usage || msg.message?.usage) as Record<string, number> | undefined;

    if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.content || msg.message?.content;
      if (typeof content === 'string') {
        return { type: 'assistant', content, model, usage };
      }
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');

        // Extract thinking blocks
        const thinkingBlocks = content
          .filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking')
          .map((b: any) => {
            if (b.type === 'redacted_thinking') {
              return '[Redacted thinking content]';
            }
            return b.thinking || b.signature || '';
          })
          .join('\n');

        // Check for tool_use blocks
        const toolBlock = content.find((b: any) => b.type === 'tool_use');
        if (toolBlock) {
          return {
            type: 'tool_use',
            toolName: toolBlock.name,
            toolInput: toolBlock.input,
          };
        }

        if (textBlocks || thinkingBlocks) {
          return {
            type: 'assistant',
            content: textBlocks || '',
            thinking: thinkingBlocks || undefined,
            model,
            usage,
          };
        }
      }
      return { type: 'assistant', content: JSON.stringify(content), model, usage };
    }

    if (msg.type === 'result') {
      return { type: 'result', content: msg.result || msg.subtype || 'done', model, usage };
    }

    return { type: msg.type || 'unknown' };
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type AgentEvent =
  | { type: 'step_start'; stepId: string; timestamp: string }
  | { type: 'agent_config'; stepId: string; data: Record<string, unknown> }
  | { type: 'thinking_stream'; stepId: string; content: string; done: boolean }
  | { type: 'ai_stream'; stepId: string; content: string; done: boolean; tokens?: number }
  | { type: 'tool_use'; stepId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'usage'; stepId: string; model: string; usage: TokenUsage }
  | { type: 'step_complete'; stepId: string; output: string; timestamp: string }
  | { type: 'step_error'; stepId: string; error: string; timestamp: string };

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
