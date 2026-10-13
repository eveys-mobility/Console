// Focused unit tests for ConsoleClient close-code handling. The full
// subscribe/snapshot path is exercised end-to-end by FleetPage and
// SystemPage tests; what's worth covering here is the auth-rejected
// branch and the reconnect-vs-give-up decision, since those affect
// session lifecycle and are hard to verify through a UI test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleClient, WS_AUTH_REJECTED_CODE, type ConnectionStatus } from '@/api/ws-client';

interface FakeSocket {
  url: string;
  protocols: string | string[] | undefined;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
}

let lastSocket: FakeSocket | null = null;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  lastSocket = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = function MockWS(
    url: string,
    protocols?: string | string[],
  ): FakeSocket {
    const s: FakeSocket = {
      url,
      protocols,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: vi.fn(),
      close: vi.fn(),
      readyState: 0,
    };
    lastSocket = s;
    return s;
  } as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ConsoleClient', () => {
  it('delivers a scoped refresh error only to its active subscription', async () => {
    const client = new ConsoleClient({ url: 'ws://fake/ws', token: 'fake' });
    client.connect();
    lastSocket?.onopen?.({});
    const onError = vi.fn();
    const pending = client.subscribe(
      'charge-point',
      { cp_id: 'A' },
      { onSnapshot: vi.fn(), onDelta: vi.fn(), onError },
    );
    const request = JSON.parse(lastSocket!.send.mock.calls.at(-1)![0]);
    lastSocket?.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'subscription.accepted',
        inReplyTo: request.id,
        subscriptionId: 'sub-A',
      }),
    });
    await pending;
    lastSocket?.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'error',
        subscriptionId: 'other',
        error: { code: 'upstream_unavailable', message: 'ignore' },
      }),
    });
    lastSocket?.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'error',
        subscriptionId: 'sub-A',
        error: { code: 'upstream_unavailable', message: 'refresh failed' },
      }),
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('refresh failed');
    client.close();
  });

  it('reissues a subscription once and keeps its unsubscribe handle valid across reconnect', async () => {
    vi.useFakeTimers();
    const client = new ConsoleClient({ url: 'ws://fake/ws', token: 'fake' });
    client.connect();
    lastSocket?.onopen?.({});
    const pending = client.subscribe(
      'charge-point',
      { cp_id: 'A' },
      { onSnapshot: vi.fn(), onDelta: vi.fn() },
    );
    const request = JSON.parse(lastSocket!.send.mock.calls.at(-1)![0]);
    lastSocket?.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'subscription.accepted',
        inReplyTo: request.id,
        subscriptionId: 'old-A',
      }),
    });
    const handle = await pending;
    lastSocket?.onclose?.({ code: 1001, reason: 'restart' });
    vi.advanceTimersByTime(1000);
    lastSocket?.onopen?.({});
    expect(lastSocket!.send).toHaveBeenCalledTimes(1);
    const replacement = JSON.parse(lastSocket!.send.mock.calls[0]![0]);
    lastSocket?.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'subscription.accepted',
        inReplyTo: replacement.id,
        subscriptionId: 'new-A',
      }),
    });
    handle.unsubscribe();
    expect(JSON.parse(lastSocket!.send.mock.calls.at(-1)![0])).toMatchObject({
      type: 'unsubscribe',
      subscriptionId: 'new-A',
    });
    lastSocket?.onclose?.({ code: 1001, reason: 'restart' });
    vi.advanceTimersByTime(1000);
    lastSocket?.onopen?.({});
    expect(lastSocket!.send).not.toHaveBeenCalled();
    client.close();
  });
  it('fires onAuthRejected and stops reconnecting when server closes with 4401', () => {
    const onAuthRejected = vi.fn();
    const onStatus = vi.fn<(s: ConnectionStatus) => void>();
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'bad-token',
      onStatus,
      onAuthRejected,
    });

    vi.useFakeTimers();
    client.connect();
    expect(lastSocket).not.toBeNull();
    expect(WS_AUTH_REJECTED_CODE).toBe(4401);

    // Simulate the server-side auth rejection.
    lastSocket?.onclose?.({ code: WS_AUTH_REJECTED_CODE, reason: 'unauthenticated' });

    expect(onAuthRejected).toHaveBeenCalledTimes(1);
    // Reconnect timer must NOT have been scheduled — advancing time
    // past any plausible backoff should not produce a new socket.
    const socketBefore = lastSocket;
    vi.advanceTimersByTime(60_000);
    expect(lastSocket).toBe(socketBefore);
  });

  it('schedules a reconnect on a non-auth close', () => {
    const onAuthRejected = vi.fn();
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
      onAuthRejected,
    });

    vi.useFakeTimers();
    client.connect();
    const firstSocket = lastSocket;
    expect(firstSocket).not.toBeNull();

    // Server-initiated close that isn't an auth rejection.
    lastSocket?.onclose?.({ code: 1011, reason: 'server error' });

    expect(onAuthRejected).not.toHaveBeenCalled();
    // Reconnect timer is scheduled with backoff; advancing past it
    // should produce a fresh socket.
    vi.advanceTimersByTime(10_000);
    expect(lastSocket).not.toBe(firstSocket);
  });

  it('does not reconnect after explicit close()', () => {
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
    });

    vi.useFakeTimers();
    client.connect();
    const firstSocket = lastSocket;

    client.close();
    // Simulate the close event that follows the explicit socket.close().
    lastSocket?.onclose?.({ code: 1000, reason: 'client.close' });

    vi.advanceTimersByTime(60_000);
    expect(lastSocket).toBe(firstSocket);
  });

  it('emits diagnostics on open and close', () => {
    const onDiagnostics = vi.fn();
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
      onDiagnostics,
    });

    client.connect();
    lastSocket?.onopen?.({});
    // After open: lastCloseCode null, attempt zero.
    expect(onDiagnostics).toHaveBeenLastCalledWith({
      lastCloseCode: null,
      lastCloseReason: null,
      reconnectAttempt: 0,
    });

    vi.useFakeTimers();
    lastSocket?.onclose?.({ code: 1006, reason: '' });
    // After close: lastCloseCode 1006, reason null (empty string normalised),
    // attempt incremented by scheduleReconnect.
    expect(onDiagnostics).toHaveBeenLastCalledWith({
      lastCloseCode: 1006,
      lastCloseReason: null,
      reconnectAttempt: 1,
    });
  });

  it('warns to the console when a non-clean close happens', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
    });

    vi.useFakeTimers();
    client.connect();
    lastSocket?.onclose?.({ code: 1006, reason: '' });

    expect(warn).toHaveBeenCalled();
    const msg = warn.mock.calls[0]?.[0] ?? '';
    expect(String(msg)).toContain('code=1006');
  });

  it('stays quiet on a clean (1000) close', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
    });

    vi.useFakeTimers();
    client.connect();
    client.close();
    lastSocket?.onclose?.({ code: 1000, reason: 'client.close' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('emits a "still trying" warning once the reconnect backoff stretches past 5s', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new ConsoleClient({
      url: 'ws://localhost:8090/ws',
      token: 'good-token',
    });

    vi.useFakeTimers();
    client.connect();
    // A few non-clean closes in a row; backoff doubles each time.
    // The "still trying" message uses the word "trying"; the per-close
    // warning uses "code=". Filter to distinguish.
    for (let i = 0; i < 6; i++) {
      lastSocket?.onclose?.({ code: 1006, reason: '' });
      vi.runOnlyPendingTimers();
    }
    const trying = warn.mock.calls.filter((args) => String(args[0] ?? '').includes('still trying'));
    expect(trying.length).toBeGreaterThan(0);
  });
});
