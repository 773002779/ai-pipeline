import { describe, it, expect, vi } from 'vitest';
import { ClaudeAgentManager } from '../claude/agent-manager';
import { resolvePermission } from '../ws/permission-store';
import { setInternalToken } from '../llm/internal-token';
import type { AgentCallConfig } from '../claude/agent-manager';
import type { Resource, StepTemplate, WsServerEvent } from '../../shared/types';

function makeTemplate(overrides: Partial<StepTemplate> = {}): StepTemplate {
  return {
    id: 't1',
    name: 'Test Step',
    category: '工具',
    description: '',
    systemPrompt: 'Do the task.',
    interactionMode: 'auto',
    autoAdvance: true,
    pauseForQuestions: false,
    collectActionItems: false,
    loopEnabled: false,
    outputFormat: 'markdown',
    ...overrides,
  };
}

function makeMcpResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'mcp-1',
    type: 'mcp',
    name: 'TestMcp',
    description: '',
    version: '1.0.0',
    source: 'manual',
    config: { command: 'npx', args: ['-y', 'test-mcp'] },
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentCallConfig> = {}): AgentCallConfig {
  return {
    sessionId: 's1',
    stepId: 'ps1',
    template: makeTemplate(),
    resolvedAgent: null,
    resolvedSkills: [],
    resolvedMcps: [],
    workspaces: [{ name: 'ws', path: 'D:/tmp/ws-proj', type: 'backend' }],
    previousOutputs: [],
    requirement: 'Build it',
    wsChannel: { broadcastToSession: () => {} } as unknown as AgentCallConfig['wsChannel'],
    ...overrides,
  };
}

interface CapturedEvent {
  type: string;
  data: Record<string, unknown>;
}

function captureChannel() {
  const events: CapturedEvent[] = [];
  return {
    events,
    channel: {
      broadcastToSession: (_sessionId: string, event: WsServerEvent) => {
        events.push(event as unknown as CapturedEvent);
      },
    } as unknown as AgentCallConfig['wsChannel'],
  };
}

describe('ClaudeAgentManager.buildSdkOptions', () => {
  it('passes resolved MCP servers to the SDK options', () => {
    const mgr = new ClaudeAgentManager();
    const cfg = makeConfig({ resolvedMcps: [makeMcpResource()] });
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(cfg);

    expect(options.mcpServers).toBeDefined();
    const servers = options.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers['TestMcp'].command).toBe('npx');
    expect(servers['TestMcp'].args).toEqual(['-y', 'test-mcp']);
  });

  it('passes SSE MCP servers with a url', () => {
    const mgr = new ClaudeAgentManager();
    const cfg = makeConfig({
      resolvedMcps: [makeMcpResource({ name: 'RemoteMcp', config: { url: 'https://example.com/sse' } })],
    });
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(cfg);
    const servers = options.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers['RemoteMcp'].url).toBe('https://example.com/sse');
  });

  it('omits mcpServers when no MCP resources are configured', () => {
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig());
    expect(options.mcpServers).toBeUndefined();
  });

  it('wires cwd, canUseTool, tools and model', () => {
    const mgr = new ClaudeAgentManager();
    const cfg = makeConfig({
      template: makeTemplate({ tools: ['Read', 'Grep'], model: 'claude-sonnet-4' }),
    });
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(cfg);

    expect(options.cwd).toBe('D:/tmp/ws-proj');
    expect(options.additionalDirectories).toEqual([]);
    expect(typeof options.canUseTool).toBe('function');
    expect(options.tools).toEqual(['Read', 'Grep']);
    expect(options.model).toBe('claude-sonnet-4');
    expect(options.persistSession).toBe(false);
  });
});

describe('ClaudeAgentManager permission hook', () => {
  it('generates unique ids for concurrent permission requests', async () => {
    const { channel, events } = captureChannel();
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig({ wsChannel: channel }));
    const hook = options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string }>;

    const controller = new AbortController();
    const p1 = hook('Bash', { command: 'ls' }, { signal: controller.signal, toolUseID: 'u1' });
    const p2 = hook('Write', { path: 'a.txt' }, { signal: controller.signal, toolUseID: 'u2' });

    await vi.waitFor(() => expect(events.filter(e => e.type === 'permission_request').length).toBe(2));

    const request1 = events.find(e => e.type === 'permission_request')!;
    const request2 = events.filter(e => e.type === 'permission_request')[1];
    const id1 = request1.data.id as string;
    const id2 = request2.data.id as string;
    expect(id1).not.toBe(id2);

    // Both requests carry session and tool info
    expect(request1.data.toolName).toBe('Bash');
    expect(request2.data.toolName).toBe('Write');

    resolvePermission(id1, 'deny');
    resolvePermission(id2, 'approve');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.behavior).toBe('deny');
    expect(r2.behavior).toBe('allow');
  });

  it('aborts a pending permission request when the signal fires', async () => {
    const { channel, events } = captureChannel();
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig({ wsChannel: channel }));
    const hook = options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string }>;

    const controller = new AbortController();
    const p = hook('Bash', {}, { signal: controller.signal, toolUseID: 'u1' });
    await vi.waitFor(() => expect(events.length).toBe(1));

    controller.abort();
    const result = await p;
    expect(result.behavior).toBe('deny');
  });

  it('assesses high risk for destructive bash commands', async () => {
    const { channel, events } = captureChannel();
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig({ wsChannel: channel }));
    const hook = options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
      ctx: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string }>;

    const controller = new AbortController();
    const p = hook('Bash', { command: 'rm -rf /' }, { signal: controller.signal, toolUseID: 'u1' });
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].data.risk).toBe('high');

    resolvePermission(events[0].data.id as string, 'deny');
    await p;
  });
});

describe('ClaudeAgentManager SDK env injection', () => {
  it('routes the SDK through the in-process proxy and isolates config dir', () => {
    setInternalToken('tok-test-1');
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig());
    const env = options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toContain('/_llm');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok-test-1');
    expect(env.CLAUDE_CONFIG_DIR).toContain('.pipeline');
    expect(env.CLAUDE_CONFIG_DIR).toContain('claude-config');
  });

  it('falls back to defaultModel when template/agent do not pin a model', () => {
    const mgr = new ClaudeAgentManager();
    const options = (mgr as unknown as { buildSdkOptions: (c: AgentCallConfig) => Record<string, unknown> })
      .buildSdkOptions(makeConfig({ defaultModel: 'deepseek-chat' }));
    expect(options.model).toBe('deepseek-chat');
  });
});
