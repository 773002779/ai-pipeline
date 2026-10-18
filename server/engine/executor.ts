import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { SessionRepository } from '../db/repositories/sessions';
import { ResourceRepository } from '../db/repositories/resources';
import { StepRepository } from '../db/repositories/steps';
import { UsageRepository } from '../db/repositories/usage';
import { SessionChannel } from '../ws/session-channel';
import { ContextBuilder } from './context-builder';
import { ResourceResolver } from './resource-resolver';
import { ClaudeAgentManager, type AgentEvent } from '../claude/agent-manager';
import type { Session, StepTemplate } from '../../shared/types';

export class PipelineExecutor {
  private contextBuilder = new ContextBuilder();
  private agentManager = new ClaudeAgentManager();

  constructor(
    private sessionRepo: SessionRepository,
    private resourceRepo: ResourceRepository,
    private stepRepo: StepRepository,
    private usageRepo?: UsageRepository,
  ) {}

  /**
   * Execute a session step by step.
   * Each step: build context → resolve resources → call Claude → save output → advance
   */
  async *execute(
    session: Session,
    wsChannel: SessionChannel,
    outputDir: string,
    options?: { defaultModel?: string },
  ): AsyncGenerator<AgentEvent> {
    const resourceResolver = new ResourceResolver(this.resourceRepo);
    const pipelineSteps = session.pipelineSnapshot.steps;

    // Start from current step
    let stepIndex = session.currentStepIndex;

    while (stepIndex < pipelineSteps.length) {
      const pipelineStep = pipelineSteps[stepIndex];
      const template = this.stepRepo.getById(pipelineStep.templateId);

      if (!template) {
        const errMsg = `Step template not found: ${pipelineStep.templateId}`;
        console.error(`[executor] ${errMsg}`);
        yield {
          type: 'step_error',
          stepId: pipelineStep.id,
          error: errMsg,
          timestamp: new Date().toISOString(),
        };
        this.sessionRepo.updateStepStatus(session.id, stepIndex, 'error', {
          errorMessage: errMsg,
        });
        this.sessionRepo.updateStatus(session.id, 'error');
        wsChannel.broadcastToSession(session.id, {
          type: 'status_change',
          data: { status: 'error', currentStepIndex: stepIndex },
        });
        return;
      }

      // Apply pipeline-level overrides
      const effectiveTemplate = this.applyOverrides(template, pipelineStep.overrides, session.stepOverrides?.[pipelineStep.id]);

      // Resolve resources
      const resolved = resourceResolver.resolve(effectiveTemplate);

      // Build context
      const context = this.contextBuilder.build(session, stepIndex);

      // Mark step as running
      this.sessionRepo.updateStepStatus(session.id, stepIndex, 'running', {
        startedAt: new Date().toISOString(),
      });
      this.sessionRepo.updateStatus(session.id, 'running', {
        currentStepIndex: stepIndex,
      });

      // Notify frontend
      wsChannel.broadcastToSession(session.id, {
        type: 'status_change',
        data: { status: 'running', currentStepIndex: stepIndex },
      });
      wsChannel.broadcastToSession(session.id, {
        type: 'step_progress',
        data: { stepName: template.name, progress: 0, currentAction: 'Starting...' },
      });

      // Execute via Claude Agent SDK
      let stepOutput = '';
      let stepError = '';
      let accumulatedContent = '';
      let accumulatedThinking = '';
      let finalStreamContent = '';

      try {
        for await (const event of this.agentManager.execute({
          sessionId: session.id,
          stepId: pipelineStep.id,
          template: effectiveTemplate,
          resolvedAgent: resolved.agent,
          resolvedSkills: resolved.skills,
          resolvedMcps: resolved.mcps,
          workspaces: session.workspaces,
          previousOutputs: context?.previousOutputs || [],
          requirement: session.requirement,
          environment: session.environment as Record<string, unknown> | undefined,
          defaultModel: options?.defaultModel,
          wsChannel,
        })) {
          // Forward events to WebSocket
          if (event.type === 'thinking_stream') {
            if (!event.done) accumulatedThinking += event.content;
            wsChannel.broadcastToSession(session.id, {
              type: 'thinking_delta',
              data: { content: event.content, done: event.done, stepId: pipelineStep.id },
            });
          }

          if (event.type === 'ai_stream') {
            if (!event.done) accumulatedContent += event.content;
            else finalStreamContent = event.content;
            wsChannel.broadcastToSession(session.id, {
              type: 'ai_message',
              data: { content: event.content, done: event.done, stepId: pipelineStep.id },
            });
            wsChannel.broadcastToSession(session.id, {
              type: 'step_progress',
              data: {
                stepName: template.name,
                progress: event.done ? 100 : Math.min(95, (event.tokens || 0) / 100),
                currentAction: event.done ? 'Complete' : 'Processing...',
              },
            });
          }

          if (event.type === 'tool_use') {
            wsChannel.broadcastToSession(session.id, {
              type: 'tool_use',
              data: { toolName: event.toolName, input: event.input },
            });
          }

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

          if (event.type === 'step_complete') {
            // The real step output is the streamed assistant text —
            // event.output only carries a summary line
            stepOutput = accumulatedContent || finalStreamContent;
            if (stepOutput || accumulatedThinking) {
              this.sessionRepo.addMessage(
                session.id,
                pipelineStep.id,
                'assistant',
                stepOutput,
                accumulatedThinking || undefined,
              );
            }
          }

          if (event.type === 'step_error') {
            stepError = event.error;
          }

          yield event;
        }
      } catch (err) {
        stepError = (err as Error).message;
        console.error(`[executor] Step ${template.name} threw:`, stepError);
      }

      // Save output
      if (!stepError) {
        const outputPath = this.saveOutput(outputDir, session.id, stepIndex, template, stepOutput);
        this.sessionRepo.updateStepStatus(session.id, stepIndex, 'completed', {
          completedAt: new Date().toISOString(),
          outputPath,
        });
        console.log(`[executor] Output saved: ${outputPath}`);
      } else {
        this.sessionRepo.updateStepStatus(session.id, stepIndex, 'error', {
          errorMessage: stepError,
        });
        this.sessionRepo.updateStatus(session.id, 'error');
        // Notify frontend of the error via WebSocket
        wsChannel.broadcastToSession(session.id, {
          type: 'status_change',
          data: { status: 'error', currentStepIndex: stepIndex },
        });
        return;
      }

      // Notify completion
      wsChannel.broadcastToSession(session.id, {
        type: 'step_complete',
        data: { stepId: pipelineStep.id, outputPath: 'output saved' },
      });

      // Auto-advance or wait for confirmation
      // interactionMode 'confirm-each' always pauses, regardless of autoAdvance
      const shouldPause =
        template.interactionMode === 'confirm-each' ||
        !template.autoAdvance;

      if (shouldPause) {
        const nextIndex = stepIndex + 1;
        this.sessionRepo.updateStatus(session.id, 'waiting_confirm', { currentStepIndex: nextIndex });
        wsChannel.broadcastToSession(session.id, {
          type: 'status_change',
          data: { status: 'waiting_confirm', currentStepIndex: nextIndex },
        });
        break; // Wait for user to continue
      } else {
        stepIndex++;
        this.sessionRepo.updateStatus(session.id, 'running', { currentStepIndex: stepIndex });
      }
    }

    // All steps complete
    if (stepIndex >= pipelineSteps.length) {
      this.sessionRepo.updateStatus(session.id, 'completed');
      wsChannel.broadcastToSession(session.id, {
        type: 'status_change',
        data: { status: 'completed', currentStepIndex: stepIndex },
      });
    }
  }

  private applyOverrides(
    template: StepTemplate,
    pipelineOverrides?: Record<string, unknown>,
    sessionOverrides?: Record<string, unknown>,
  ): StepTemplate {
    const merged = { ...template };
    const overrides = { ...pipelineOverrides, ...sessionOverrides };

    if (overrides.systemPrompt) {
      merged.systemPrompt = `${template.systemPrompt}\n\n## Additional Instructions\n${overrides.systemPrompt}`;
    }
    if (overrides.model) merged.model = overrides.model as string;
    if (overrides.interactionMode) {
      merged.interactionMode = overrides.interactionMode as StepTemplate['interactionMode'];
    }
    if (overrides.loopConfig) {
      merged.defaultLoopConfig = overrides.loopConfig as StepTemplate['defaultLoopConfig'];
    }

    return merged;
  }

  private saveOutput(
    outputDir: string,
    sessionId: string,
    stepIndex: number,
    template: StepTemplate,
    content: string,
  ): string {
    const sessionDir = path.join(outputDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const stepNum = String(stepIndex + 1).padStart(2, '0');
    const fileName = `step-${stepNum}-${template.name.replace(/[^a-z0-9一-鿿]+/gi, '-')}.md`;
    const filePath = path.join(sessionDir, fileName);

    const fullContent = [
      `# ${template.name} - Output`,
      `> Step: ${stepIndex + 1}`,
      `> Template: ${template.id}`,
      `> Completed: ${new Date().toISOString()}`,
      '',
      content || '*No output generated*',
    ].join('\n');

    fs.writeFileSync(filePath, fullContent, 'utf-8');
    return filePath;
  }
}
