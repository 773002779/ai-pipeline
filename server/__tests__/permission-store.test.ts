import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForPermission, resolvePermission, cancelSessionPermissions } from '../ws/permission-store';

describe('permission-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves allow when the user approves', async () => {
    const p = waitForPermission('p1', 's1');
    expect(resolvePermission('p1', 'approve')).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('resolves allow when the user whitelists', async () => {
    const p = waitForPermission('p2', 's1');
    resolvePermission('p2', 'whitelist');
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('resolves deny when the user denies', async () => {
    const p = waitForPermission('p3', 's1');
    resolvePermission('p3', 'deny');
    const result = await p;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });

  it('returns false when resolving an unknown permission id', () => {
    expect(resolvePermission('no-such-id', 'approve')).toBe(false);
  });

  it('resolves deny after the timeout elapses', async () => {
    const p = waitForPermission('p4', 's1', 1_000);
    vi.advanceTimersByTime(1_500);
    const result = await p;
    expect(result.behavior).toBe('deny');
    // Timed-out entry must be gone from the store
    expect(resolvePermission('p4', 'approve')).toBe(false);
  });

  it('denies all pending permissions when the session is cancelled', async () => {
    const p = waitForPermission('p5', 'session-x');
    cancelSessionPermissions('session-x');
    const result = await p;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toContain('cancelled');
    expect(resolvePermission('p5', 'approve')).toBe(false);
  });

  it('does not touch pending permissions of other sessions on cancel', async () => {
    const p = waitForPermission('p6', 'session-a');
    cancelSessionPermissions('session-b');
    // p6 must still be resolvable
    expect(resolvePermission('p6', 'approve')).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('resolves deny immediately when the abort signal fires while pending', async () => {
    const controller = new AbortController();
    const p = waitForPermission('p7', 's1', 60_000, controller.signal);
    controller.abort();
    const result = await p;
    expect(result.behavior).toBe('deny');
    expect(resolvePermission('p7', 'approve')).toBe(false);
  });

  it('resolves deny immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const p = waitForPermission('p8', 's1', 60_000, controller.signal);
    const result = await p;
    expect(result.behavior).toBe('deny');
  });

  it('does not fire the timeout after the request was resolved', async () => {
    const p = waitForPermission('p9', 's1', 1_000);
    resolvePermission('p9', 'approve');
    await p;
    // Advancing past the timeout must not reject/resolve anything observable
    vi.advanceTimersByTime(5_000);
  });
});
