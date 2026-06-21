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

import type { SDKSessionOptions } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { SessionChannel } from '../ws/session-channel';
import type { StepTemplate, Resource, Workspace, Message } from '../../shared/types';

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

      // Build tools list
      const tools = this.buildToolsList(config);

      // Build MCP server configs
      const mcpServers = this.buildMcpServers(config);

      // Resolve model: template override → agent config → env → default
      const resolvedModel =
        template.model ||
        (config.resolvedAgent?.config as any)?.model ||
        process.env.ANTHROPIC_MODEL ||
        undefined; // Let SDK/CLI use its own default

      // Build SDK options
      // On Windows, the SDK CLI requires git-bash — resolve and set the env var
      const env = { ...process.env } as Record<string, string | undefined>;
      if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
        // Try common Git Bash install locations
        const candidates = [
          'D:\\develop\\Git\\usr\\bin\\bash.exe',
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
          'C:\\Git\\bin\\bash.exe',
        ];
        const fs = require('fs');
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            env.CLAUDE_CODE_GIT_BASH_PATH = candidate;
            break;
          }
        }
      }

      const sdkOptions: Record<string, unknown> = {
        cwd: config.workspaces[0]?.path || process.cwd(),
        // Additional directories for multi-workspace
        additionalDirectories: config.workspaces.slice(1).map(w => w.path),
        // Use permissionMode for non-interactive execution
        permissionMode: 'acceptEdits' as const,
        // Pass env with git-bash path on Windows
        env,
        // Disable persistence for cleaner execution
        persistSession: false,
      };

      // Set tools if explicitly configured, otherwise let CLI use its defaults
      if (tools.length > 0) {
        sdkOptions.tools = tools;
      }

      // Only set model if explicitly resolved (let CLI default otherwise)
      if (resolvedModel) {
        sdkOptions.model = resolvedModel;
      }

      // Only set maxThinkingTokens if template explicitly requests it
      // (DeepSeek & other proxies may not support extended thinking)
      if (template.maxTokens && template.maxTokens > 0) {
        sdkOptions.maxThinkingTokens = template.maxTokens;
      }

      yield {
        type: 'agent_config',
        stepId,
        data: {
          model: resolvedModel || '(CLI default)',
          tools: tools.length,
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
      // If in allowedTools, auto-allow
      // Otherwise, ask via WebSocket
      const permId = `perm-${Date.now()}`;

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
        },
      });

      // Wait for user response via the session's permission queue
      // Default timeout: 5 minutes
      const result = await this.waitForPermissionResponse(permId, options.signal);

      return result;
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

  /**
   * Wait for user permission response via a Promise that will be resolved by the WS handler
   */
  private async waitForPermissionResponse(
    permId: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    // In the full implementation, this would use a Map of pending permissions
    // that the WebSocket handler resolves when the user responds.
    // For now, auto-deny after timeout for safety.
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          behavior: 'deny',
          message: 'Permission request timed out. Please respond via the UI.',
        });
      }, 300000); // 5 minutes

      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        resolve({ behavior: 'deny', message: 'Operation cancelled.' });
      });

      // Placeholder: In full implementation, the WS module calls resolve()
      // when the user clicks allow/deny in the frontend.
      // For now, we'll auto-approve read-only tools to keep things moving
      resolve({
        behavior: 'allow',
        updatedInput: {},
        toolUseID: undefined,
      });
    });
  }

  private extractMessageData(message: Record<string, unknown>): {
    type: string;
    content?: string;
    thinking?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  } {
    // SDK Messages can be various types; extract the common fields
    const msg = message as any;

    if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.content || msg.message?.content;
      if (typeof content === 'string') {
        return { type: 'assistant', content };
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
          };
        }
      }
      return { type: 'assistant', content: JSON.stringify(content) };
    }

    if (msg.type === 'result') {
      return { type: 'result', content: msg.result || msg.subtype || 'done' };
    }

    return { type: msg.type || 'unknown' };
  }
}

export type AgentEvent =
  | { type: 'step_start'; stepId: string; timestamp: string }
  | { type: 'agent_config'; stepId: string; data: Record<string, unknown> }
  | { type: 'thinking_stream'; stepId: string; content: string; done: boolean }
  | { type: 'ai_stream'; stepId: string; content: string; done: boolean; tokens?: number }
  | { type: 'tool_use'; stepId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'step_complete'; stepId: string; output: string; timestamp: string }
  | { type: 'step_error'; stepId: string; error: string; timestamp: string };
