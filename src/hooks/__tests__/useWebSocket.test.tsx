// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from '../useWebSocket';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  send(): void {}

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe('useWebSocket reconnect handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function exhaustReconnects(): Promise<number> {
    // Close the socket 5 times, advancing past the backoff each time
    for (let i = 0; i < 5; i++) {
      const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      act(() => { sock.simulateClose(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    }
    return FakeWebSocket.instances.length;
  }

  it('retries connecting when the session changes after exhausting reconnects', async () => {
    const { rerender } = renderHook(({ sid }) => useWebSocket(sid), {
      initialProps: { sid: 'session-A' },
    });

    const countAfterA = await exhaustReconnects();
    // 1 initial + 4 retries; the 5th close exhausts the counter (5 < 5 is false)
    expect(countAfterA).toBe(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(FakeWebSocket.instances.length).toBe(5);

    // Switching to a new session must start a fresh connection attempt
    rerender({ sid: 'session-B' });
    const last = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(FakeWebSocket.instances.length).toBeGreaterThan(countAfterA);
    expect(last.url).toContain('sessionId=session-B');
  });

  it('resets the backoff counter after a successful connection', async () => {
    renderHook(({ sid }) => useWebSocket(sid), { initialProps: { sid: 'session-A' } });

    // Fail once, then connect successfully
    const first = FakeWebSocket.instances[0];
    act(() => { first.simulateClose(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    const reconnected = FakeWebSocket.instances[1];
    act(() => { reconnected.simulateOpen(); });

    // After a successful open, one more failure should still schedule a retry
    act(() => { reconnected.simulateClose(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(FakeWebSocket.instances.length).toBe(3);
  });
});
