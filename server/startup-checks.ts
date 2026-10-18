import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface StartupChecks {
  cliBundled: boolean;
  gitBashPath?: string;
  gitBashStatus: 'ok' | 'missing' | 'not-windows';
  hasActiveProvider: boolean;
}

const GIT_BASH_CANDIDATES = [
  'D:\\develop\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Git\\bin\\bash.exe',
];

export function runStartupChecks(opts: { hasActiveProvider: boolean }): StartupChecks {
  const cliPath = path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  const cliBundled = fs.existsSync(cliPath);

  let gitBashStatus: StartupChecks['gitBashStatus'] = 'not-windows';
  let gitBashPath: string | undefined;
  if (process.platform === 'win32') {
    const fromEnv = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (fromEnv && fs.existsSync(fromEnv)) {
      gitBashPath = fromEnv;
      gitBashStatus = 'ok';
    } else {
      gitBashStatus = 'missing';
      for (const c of GIT_BASH_CANDIDATES) {
        if (fs.existsSync(c)) { gitBashPath = c; gitBashStatus = 'ok'; break; }
      }
      if (gitBashStatus === 'missing') {
        try { execSync('where bash', { stdio: 'ignore' }); gitBashStatus = 'ok'; } catch { /* 保持 missing */ }
      }
    }
  }
  return { cliBundled, gitBashPath, gitBashStatus, hasActiveProvider: opts.hasActiveProvider };
}
