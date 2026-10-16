import type { Session, StepTemplate, EnvironmentContext } from '../../shared/types';

export interface StepContext {
  systemPrompt: string;
  requirement: string;
  workspacePaths: string[];
  environment: EnvironmentContext | undefined;
  previousOutputs: Array<{
    stepName: string;
    path: string;
    summary: string;
  }>;
  actionItems: Array<{
    severity: string;
    title: string;
    description: string;
    file?: string;
    line?: number;
  }>;
}

export class ContextBuilder {
  /**
   * Build the execution context for a specific step in a session.
   * The context is a combination of:
   * 1. The step template's configuration
   * 2. The session's requirement and workspaces
   * 3. Outputs from previous steps
   * 4. Environment information from precheck
   */
  build(session: Session, stepIndex: number): StepContext | null {
    const pipelineSteps = session.pipelineSnapshot.steps;
    const sessionStep = session.steps[stepIndex];

    if (!sessionStep || !pipelineSteps[stepIndex]) {
      return null;
    }

    // Gather previous step outputs (steps before current index)
    const previousOutputs = session.steps
      .slice(0, stepIndex)
      .filter(s => s.status === 'completed' && s.outputPath)
      .map(s => ({
        stepName: s.stepName,
        path: s.outputPath || '',
        summary: `Completed at ${s.completedAt || 'unknown'}`,
      }));

    // Collect action items from previous steps
    const actionItems: StepContext['actionItems'] = [];
    // (action items are fetched separately from DB)

    return {
      systemPrompt: '', // Will be filled by ResourceResolver
      requirement: session.requirement,
      workspacePaths: session.workspaces.map(w => w.path),
      environment: session.environment,
      previousOutputs,
      actionItems,
    };
  }
}
