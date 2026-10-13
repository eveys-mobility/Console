// Unit tests for the command-transcript hook. Pin: send appends a
// pending entry, completion mutates it in place with outcome / status
// / elapsed, RPC reject surfaces an error entry, pause buffers
// completions and resume flushes, clear empties.

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTranscriptStoresForTests,
  useCommandTranscript,
} from '@/hooks/use-command-transcript';

function makeClient() {
  return {
    rpc: vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => {
      return { status: 'Accepted' };
    }),
  };
}

describe('useCommandTranscript', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Per-cp_id transcript stores live at module scope so they
    // survive component unmount. Wipe between tests so one spec's
    // entries don't leak into the next.
    __resetTranscriptStoresForTests();
  });

  it.each([null, {}, { unexpected: true }, { status: 'invented-status' }])(
    'does not accept an unknown/malformed reset reply: %j',
    async (response) => {
      const client = makeClient();
      client.rpc.mockResolvedValueOnce(response);
      const onResult = vi.fn();
      const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
      await act(async () => {
        await result.current.send('reset', { type: 'Soft' }, onResult);
      });
      expect(result.current.entries[0]!.outcome).toBe('unknown');
      expect(result.current.entries[0]!.status).toBe('Result unknown');
      expect(onResult).not.toHaveBeenCalled();
    },
  );

  it('does not run a success callback for a rejected command', async () => {
    const client = makeClient();
    client.rpc.mockResolvedValueOnce({ status: 'Rejected' });
    const onResult = vi.fn();
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
    await act(async () => {
      await result.current.send('remote-stop', { transaction_id: 42 }, onResult);
    });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('accepts valid status-less configuration keys and RebootRequired only for configuration changes', async () => {
    const client = makeClient();
    const config = {
      configuration_key: [
        { key: 'StopTransactionOnEVSideDisconnect', readonly: false, value: 'true' },
      ],
      unknown_key: [],
    };
    client.rpc.mockResolvedValueOnce(config).mockResolvedValueOnce({ status: 'RebootRequired' });
    const onResult = vi.fn();
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
    await act(async () => {
      await result.current.send('get-configuration', {}, onResult);
      await result.current.send('change-configuration', { key: 'k', value: 'v' });
    });
    expect(result.current.entries.map((entry) => entry.outcome)).toEqual(['accepted', 'accepted']);
    expect(onResult).toHaveBeenCalledWith(config);
  });

  it.each([
    { method: 'unlock-connector', response: { status: 'Accepted' }, outcome: 'unknown' },
    { method: 'unknown-command', response: { status: 'Accepted' }, outcome: 'unknown' },
    { method: 'constructor', response: { status: 'Accepted' }, outcome: 'unknown' },
    { method: 'unlock-connector', response: { status: 'Unlocked' }, outcome: 'accepted' },
    { method: 'change-configuration', response: { status: 'Accepted' }, outcome: 'accepted' },
    { method: 'reset', response: { status: 'Unlocked' }, outcome: 'unknown' },
    { method: 'reset', response: { status: 'RebootRequired' }, outcome: 'unknown' },
    {
      method: 'get-configuration',
      response: { configuration_key: ['invalid'], unknown_key: [] },
      outcome: 'unknown',
    },
    { method: 'get-diagnostics', response: { file_name: '' }, outcome: 'soft-reject' },
    { method: 'get-diagnostics', response: { file_name: 'diagnostics.log' }, outcome: 'accepted' },
  ])(
    'interprets $method replies using their own contract: $outcome',
    async ({ method, response, outcome }) => {
      const client = makeClient();
      client.rpc.mockResolvedValueOnce(response);
      const onResult = vi.fn();
      const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
      await act(async () => {
        await result.current.send(method, {}, onResult);
      });
      expect(result.current.entries[0]!.outcome).toBe(outcome);
      if (outcome === 'accepted') expect(onResult).toHaveBeenCalledWith(response);
      else expect(onResult).not.toHaveBeenCalled();
    },
  );

  it('appends a pending entry on send and resolves to ok + accepted', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));

    await act(async () => {
      await result.current.send('reset', { type: 'Soft' });
    });

    expect(result.current.entries).toHaveLength(1);
    const e = result.current.entries[0]!;
    expect(e.method).toBe('reset');
    expect(e.request).toEqual({ cp_id: 'cp_TEST', type: 'Soft' });
    expect(e.phase).toBe('ok');
    expect(e.outcome).toBe('accepted');
    expect(e.status).toBe('Accepted');
    expect(typeof e.elapsedMs).toBe('number');
  });

  it('maps an "Occupied" response to soft-reject', async () => {
    const client = makeClient();
    client.rpc.mockResolvedValueOnce({ status: 'Occupied' });
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));

    await act(async () => {
      await result.current.send('reserve-now', { connector_id: 1 });
    });
    expect(result.current.entries[0]!.outcome).toBe('soft-reject');
    expect(result.current.entries[0]!.status).toBe('Occupied');
  });

  it('maps a "Rejected" response to rejected', async () => {
    const client = makeClient();
    client.rpc.mockResolvedValueOnce({ status: 'Rejected' });
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));

    await act(async () => {
      await result.current.send('remote-stop', { transaction_id: 0 });
    });
    expect(result.current.entries[0]!.outcome).toBe('rejected');
  });

  it('surfaces a transport error on rpc reject', async () => {
    const client = makeClient();
    client.rpc.mockRejectedValueOnce(new Error('ws closed'));
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));

    await act(async () => {
      await result.current.send('reset', { type: 'Hard' });
    });
    const e = result.current.entries[0]!;
    expect(e.phase).toBe('error');
    expect(e.outcome).toBe('error');
    expect(e.error).toBe('ws closed');
  });

  it('clear() empties the entries list', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
    await act(async () => {
      await result.current.send('reset', { type: 'Soft' });
    });
    expect(result.current.entries).toHaveLength(1);
    act(() => result.current.clear());
    expect(result.current.entries).toHaveLength(0);
  });

  it('tracks inFlight while pending and drops on completion', async () => {
    const client = makeClient();
    // Hold the promise so we can inspect mid-flight.
    let resolve: ((value: unknown) => void) | undefined;
    client.rpc.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.send('reset', { type: 'Soft' });
    });
    expect(result.current.inFlight.has('reset')).toBe(true);

    await act(async () => {
      resolve!({ status: 'Accepted' });
      await sendPromise;
    });
    expect(result.current.inFlight.has('reset')).toBe(false);
  });

  it('survives component unmount + remount for the same cp_id', async () => {
    // Live tracking across tab switches and route navigation: the
    // operator fires a command on cp_A, navigates away, comes back —
    // the entry is still there. Module-level store + useSyncExternalStore.
    const client = makeClient();
    const a1 = renderHook(() => useCommandTranscript(client, 'cp_A'));
    await act(async () => {
      await a1.result.current.send('reset', { type: 'Soft' });
    });
    expect(a1.result.current.entries).toHaveLength(1);
    a1.unmount();

    const a2 = renderHook(() => useCommandTranscript(client, 'cp_A'));
    expect(a2.result.current.entries).toHaveLength(1);
    expect(a2.result.current.entries[0]!.method).toBe('reset');
  });

  it('keeps each cp_id transcript isolated', async () => {
    const client = makeClient();
    const a = renderHook(() => useCommandTranscript(client, 'cp_A'));
    await act(async () => {
      await a.result.current.send('reset', { type: 'Soft' });
    });
    const b = renderHook(() => useCommandTranscript(client, 'cp_B'));
    // cp_B should start empty even though cp_A has an entry.
    expect(b.result.current.entries).toHaveLength(0);
  });

  it('pause buffers completions; resume flushes them into the list', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useCommandTranscript(client, 'cp_TEST'));
    // Pause BEFORE the send so the completion lands in the buffer.
    act(() => result.current.pause());

    await act(async () => {
      await result.current.send('reset', { type: 'Soft' });
    });
    // The pending entry is in the list (the append happens at send
    // start, not at completion). What's buffered is the completion
    // patch — phase / status / etc — until resume is called.
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0]!.phase).toBe('pending');

    act(() => result.current.resume());
    await waitFor(() => expect(result.current.entries[0]!.phase).toBe('ok'));
  });
});
