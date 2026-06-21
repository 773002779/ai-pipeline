import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import type { Workspace, EnvironmentContext, WorkspaceEnv } from '../../shared/types';

export class PrecheckEngine {
  /**
   * Scan all workspaces and detect tech stack + available tools.
   */
  async run(workspaces: Workspace[]): Promise<EnvironmentContext> {
    const workspaceEnvs: WorkspaceEnv[] = [];
    const availableTools: string[] = [];

    for (const ws of workspaces) {
      workspaceEnvs.push(await this.scanWorkspace(ws));
    }

    // Detect available CLI tools
    const toolChecks = ['java', 'node', 'npm', 'git', 'python', 'python3', 'cargo', 'mvn', 'gradle'];
    for (const tool of toolChecks) {
      if (this.commandExists(tool)) {
        const cleanName = tool === 'python3' ? 'python' : tool;
        if (!availableTools.includes(cleanName)) availableTools.push(cleanName);
      }
    }

    return {
      workspaces: workspaceEnvs,
      availableTools,
      missingButNeeded: [],
      detectedAt: new Date().toISOString(),
    };
  }

  private async scanWorkspace(ws: Workspace): Promise<WorkspaceEnv> {
    const techStack: string[] = [];
    const dependencies: Record<string, string> = {};

    if (!fs.existsSync(ws.path)) {
      return { name: ws.name, path: ws.path, techStack: ['unknown'], dependencies };
    }

    const files = fs.readdirSync(ws.path);

    // Detect package.json → Node.js
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ws.path, 'package.json'), 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['react']) techStack.push('react');
        if (deps['vue']) techStack.push('vue');
        if (deps['next']) techStack.push('nextjs');
        if (deps['typescript']) techStack.push('typescript');
        techStack.push('nodejs');
        Object.assign(dependencies, deps);
      } catch { /* ignore parse errors */ }
    }

    // Detect pom.xml → Java/Maven
    if (files.includes('pom.xml')) {
      techStack.push('java', 'maven');
      try {
        const pom = fs.readFileSync(path.join(ws.path, 'pom.xml'), 'utf-8');
        if (pom.includes('spring-boot')) techStack.push('spring-boot');
      } catch { /* ignore */ }
    }

    // Detect build.gradle → Java/Gradle
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
      techStack.push('java', 'gradle');
    }

    // Detect Cargo.toml → Rust
    if (files.includes('Cargo.toml')) {
      techStack.push('rust');
    }

    // Detect requirements.txt / setup.py / pyproject.toml → Python
    if (files.includes('requirements.txt') || files.includes('setup.py') || files.includes('pyproject.toml')) {
      techStack.push('python');
    }

    // Detect go.mod → Go
    if (files.includes('go.mod')) {
      techStack.push('go');
    }

    if (techStack.length === 0) {
      techStack.push('unknown');
    }

    return { name: ws.name, path: ws.path, techStack, dependencies };
  }

  private commandExists(cmd: string): boolean {
    try {
      execSync(`where ${cmd} 2>nul || which ${cmd} 2>/dev/null || command -v ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
