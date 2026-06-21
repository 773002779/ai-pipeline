import type { StepTemplate, Resource } from '../../shared/types';
import { ResourceRepository } from '../db/repositories/resources';

export interface ResolvedResources {
  agent: Resource | null;
  skills: Resource[];
  mcps: Resource[];
}

export class ResourceResolver {
  constructor(private resourceRepo: ResourceRepository) {}

  /**
   * Resolve all resource references in a step template to actual Resource objects.
   */
  resolve(template: StepTemplate): ResolvedResources {
    let agent: Resource | null = null;
    const skills: Resource[] = [];
    const mcps: Resource[] = [];

    // Resolve agent
    if (template.agentId) {
      agent = this.resourceRepo.getById(template.agentId);
    }

    // Resolve skills
    if (template.skillIds) {
      for (const skillId of template.skillIds) {
        const skill = this.resourceRepo.getById(skillId);
        if (skill && skill.enabled) {
          skills.push(skill);
        }
      }
    }

    // Resolve MCPs
    if (template.mcpServerIds) {
      for (const mcpId of template.mcpServerIds) {
        const mcp = this.resourceRepo.getById(mcpId);
        if (mcp && mcp.enabled) {
          mcps.push(mcp);
        }
      }
    }

    // Apply resource overrides
    if (template.resourceOverrides) {
      if (agent && template.resourceOverrides.agent) {
        const agentConfig = agent.config as any;
        const overrides = template.resourceOverrides.agent;
        if (overrides.model) agentConfig.model = overrides.model;
        if (overrides.maxTokens) agentConfig.maxTokens = overrides.maxTokens;
        agent = { ...agent, config: agentConfig };
      }

      if (template.resourceOverrides.skills) {
        for (const skill of skills) {
          const overrides = template.resourceOverrides.skills[skill.id];
          if (overrides?.inputParams) {
            const skillConfig = skill.config as any;
            skillConfig.inputParams = { ...skillConfig.inputParams, ...overrides.inputParams };
            skill.config = skillConfig;
          }
        }
      }
    }

    return { agent, skills, mcps };
  }
}
