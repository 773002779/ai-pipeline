/**
 * Shared store for pending permission requests.
 * Bridges canUseTool callbacks → WebSocket → user response.
 */
import { v4 as uuidv4 } from 'uuid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  sessionId: string;
  timeout: NodeJS.Timeout;
  onAbort?: () => void;
}

const pending = new Map<string, PendingPermission>();

/** Register a pending permission and return a promise that resolves on user action */
export function waitForPermission(
  permId: string = uuidv4(),
  sessionId: string,
  timeoutMs: number = 300_000,
  signal?: AbortSignal,
): Promise<PermissionResult> {
  return new Promise((resolve) => {
    let entry!: PendingPermission;
    const settle = (result: PermissionResult) => {
      clearTimeout(entry.timeout);
      if (entry.onAbort && signal) {
        signal.removeEventListener('abort', entry.onAbort);
      }
      pending.delete(permId);
      resolve(result);
    };

    entry = {
      resolve: settle,
      sessionId,
      timeout: setTimeout(() => {
        settle({
          behavior: 'deny',
          message: 'Permission request timed out. Please respond via the UI.',
        });
      }, timeoutMs),
    };

    if (signal) {
      if (signal.aborted) {
        settle({ behavior: 'deny', message: 'Operation cancelled.' });
        return;
      }
      entry.onAbort = () => settle({ behavior: 'deny', message: 'Operation cancelled.' });
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }

    pending.set(permId, entry);
  });
}

/** Resolve a pending permission from a user response */
export function resolvePermission(permId: string, action: 'approve' | 'deny' | 'whitelist'): boolean {
  const entry = pending.get(permId);
  if (!entry) return false;

  if (action === 'deny') {
    entry.resolve({ behavior: 'deny', message: 'Denied by user.' });
  } else {
    entry.resolve({ behavior: 'allow', updatedInput: {} });
  }
  return true;
}

/** Clean up all pending permissions for a session (e.g., on cancel) */
export function cancelSessionPermissions(sessionId: string): void {
  for (const [, entry] of pending) {
    if (entry.sessionId === sessionId) {
      entry.resolve({ behavior: 'deny', message: 'Session cancelled' });
    }
  }
}
