import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runStartupChecks } from '../startup-checks';

const originalPlatform = process.platform;
const originalEnvPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;

function stubPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  stubPlatform(originalPlatform);
  if (originalEnvPath === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
  else process.env.CLAUDE_CODE_GIT_BASH_PATH = originalEnvPath;
});

describe('runStartupChecks', () => {
  it('reports not-windows on non-Windows platforms', () => {
    stubPlatform('linux');
    const checks = runStartupChecks({ hasActiveProvider: false });
    expect(checks.gitBashStatus).toBe('not-windows');
    expect(checks.gitBashPath).toBeUndefined();
  });

  it('uses CLAUDE_CODE_GIT_BASH_PATH when it points to an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-checks-'));
    const bashPath = path.join(dir, 'bash.exe');
    fs.writeFileSync(bashPath, '', 'utf-8');
    stubPlatform('win32');
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
    try {
      const checks = runStartupChecks({ hasActiveProvider: false });
      expect(checks.gitBashStatus).toBe('ok');
      expect(checks.gitBashPath).toBe(bashPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
