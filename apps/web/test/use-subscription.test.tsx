import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargePointSummary, DeltaForQuery, SnapshotForQuery } from '@eveys-console/protocol';

const transport = vi.hoisted(() => ({
  status: 'open',
  subscriptions: [] as Array<{
    onSnapshot: (snapshot: SnapshotForQuery, cursor: string) => void;
    onDelta: (delta: DeltaForQuery, cursor: string) => void;
    onError: (message: string) => void;
  }>,
  subscribe: vi.fn(),
}));
vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({ client: transport, status: transport.status }),
}));
import { useSubscription } from '@/hooks/use-subscription';

const cp = (id: string, status = 'Available', at = '2026-10-13T10:00:00Z'): ChargePointSummary => ({
  cp_id: id,
  online: true,
  pod_id: 'fake',
  vendor: null,
  model: null,
  firmware_version: null,
  serial_number: null,
  last_boot_at: null,
  last_heartbeat_at: null,
  last_status: status,
  connectors: [{ connector_id: 1, status, error_code: null, last_changed_at: at }],
});
beforeEach(() => {
  transport.status = 'open';
  transport.subscriptions = [];
  transport.subscribe.mockImplementation((_query, _params, handlers) => {
    transport.subscriptions.push(handlers);
    return Promise.resolve({ unsubscribe: vi.fn() });
  });
  vi.stubGlobal('fetch', () => {
    throw new Error('Unexpected network');
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useSubscription scope and cumulative data', () => {
  it('retains a successful connector snapshot on archive failure and marks it unavailable', () => {
    const { result } = renderHook(() => useSubscription('charge-point', { cp_id: 'A' }));
    const h = transport.subscriptions[0]!;
    const successful = {
      ...cp('A'),
      connectors_state: 'available' as const,
      connectors_last_successful_at: '2026-10-13T10:00:00Z',
    };
    act(() => h.onSnapshot({ kind: 'charge-point', row: successful }, 'success'));
    act(() =>
      h.onSnapshot(
        {
          kind: 'charge-point',
          row: {
            ...cp('A'),
            connectors: [],
            connectors_state: 'unavailable',
            connectors_last_successful_at: null,
          },
        },
        'failed',
      ),
    );
    expect(result.current.snapshot).toMatchObject({
      row: {
        connectors_state: 'unavailable',
        connectors_last_successful_at: '2026-10-13T10:00:00Z',
        connectors: [{ connector_id: 1 }],
      },
    });
    act(() =>
      h.onSnapshot(
        {
          kind: 'charge-point',
          row: {
            ...cp('A'),
            connectors: [],
            connectors_state: 'available',
            connectors_last_successful_at: '2026-10-13T10:02:00Z',
          },
        },
        'confirmed-empty',
      ),
    );
    expect(result.current.snapshot).toMatchObject({
      row: { connectors_state: 'available', connectors: [] },
    });
  });

  it('keeps one subscription through reconnect and clears error and delta when its fresh snapshot arrives', () => {
    const { result, rerender } = renderHook(() => useSubscription('charge-point', { cp_id: 'A' }));
    const h = transport.subscriptions[0]!;
    act(() => h.onSnapshot({ kind: 'charge-point', row: cp('A') }, 'initial'));
    act(() => h.onDelta({ kind: 'charge-point', row: cp('A', 'Charging') }, 'delta'));
    transport.status = 'closed';
    rerender();
    expect(result.current.error).toContain('Showing last known data');
    transport.status = 'open';
    rerender();
    act(() => h.onSnapshot({ kind: 'charge-point', row: cp('A', 'Faulted') }, 'replacement'));
    expect(transport.subscriptions).toHaveLength(1);
    expect(result.current).toMatchObject({
      error: null,
      lastDelta: null,
      cursor: 'replacement',
      snapshot: { row: { last_status: 'Faulted' } },
    });
  });
  it('retains updates for both fleet rows after consecutive events', () => {
    const { result } = renderHook(() => useSubscription('charge-points', {}));
    const handlers = transport.subscriptions[0]!;
    act(() => handlers.onSnapshot({ kind: 'charge-points', rows: [cp('A'), cp('B')] }, 'snapshot'));
    act(() =>
      handlers.onDelta({ kind: 'charge-points', op: 'upsert', row: cp('A', 'Charging') }, 'a'),
    );
    act(() =>
      handlers.onDelta({ kind: 'charge-points', op: 'upsert', row: cp('B', 'Faulted') }, 'b'),
    );
    const snapshot = result.current.snapshot;
    expect(snapshot?.kind).toBe('charge-points');
    if (snapshot?.kind === 'charge-points')
      expect(snapshot.rows.map((row) => row.last_status)).toEqual(['Charging', 'Faulted']);
  });

  it('resets all old scope data before the next charger snapshot arrives', () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSubscription('charge-point', { cp_id: id }),
      { initialProps: { id: 'A' } },
    );
    const old = transport.subscriptions[0]!;
    act(() => old.onSnapshot({ kind: 'charge-point', row: cp('A') }, 'a'));
    act(() => old.onDelta({ kind: 'charge-point', row: cp('A', 'Charging') }, 'a2'));
    act(() => old.onError('upstream unavailable'));
    rerender({ id: 'B' });
    expect(result.current).toMatchObject({
      loading: true,
      error: null,
      snapshot: null,
      lastDelta: null,
      cursor: null,
    });
    act(() => old.onDelta({ kind: 'charge-point', row: cp('A', 'Faulted') }, 'late-a'));
    expect(result.current.snapshot).toBeNull();
  });

  it('ignores a delta for another charger and clears old error on a fresh snapshot', () => {
    const { result } = renderHook(() => useSubscription('charge-point', { cp_id: 'A' }));
    const h = transport.subscriptions[0]!;
    act(() => h.onSnapshot({ kind: 'charge-point', row: cp('A') }, 'a'));
    act(() => h.onDelta({ kind: 'charge-point', row: cp('B', 'Charging') }, 'wrong'));
    expect(result.current.lastDelta).toBeNull();
    act(() => h.onError('failed refetch'));
    act(() => h.onSnapshot({ kind: 'charge-point', row: cp('A', 'Charging') }, 'fresh'));
    expect(result.current.error).toBeNull();
    expect(result.current.lastDelta).toBeNull();
  });

  it('compares connector timestamps by UTC instant and retains other known connectors', () => {
    const { result } = renderHook(() => useSubscription('charge-point', { cp_id: 'A' }));
    const h = transport.subscriptions[0]!;
    const row = cp('A', 'Charging', '2026-10-13T10:00:00Z');
    row.connectors.push({
      connector_id: 2,
      status: 'Available',
      error_code: null,
      last_changed_at: '2026-10-13T10:00:00Z',
    });
    act(() => h.onSnapshot({ kind: 'charge-point', row }, 's'));
    act(() =>
      h.onDelta(
        { kind: 'charge-point', row: cp('A', 'SuspendedEV', '2026-10-13T13:01:00+03:00') },
        'new',
      ),
    );
    expect(result.current.snapshot).toMatchObject({
      row: {
        connectors: [
          { connector_id: 1, status: 'SuspendedEV' },
          { connector_id: 2, status: 'Available' },
        ],
      },
    });
    act(() =>
      h.onDelta(
        { kind: 'charge-point', row: cp('A', 'Faulted', '2026-10-13T11:00:00+03:00') },
        'old',
      ),
    );
    const snapshot = result.current.snapshot;
    if (snapshot?.kind === 'charge-point')
      expect(snapshot.row.connectors.map((c) => c.status)).toEqual(['SuspendedEV', 'Available']);
    else throw new Error('Missing charger snapshot');
  });

  it('removes a stopped transaction from the active snapshot', () => {
    const { result } = renderHook(() => useSubscription('transactions-active', {}));
    const h = transport.subscriptions[0]!;
    const row = {
      transaction_id: 7,
      cp_id: 'A',
      connector_id: 1,
      id_tag: 'fake',
      meter_start_wh: 0,
      meter_stop_wh: null,
      consumed_wh: null,
      started_reported_at: '2026-10-13T10:00:00Z',
      started_received_at: '2026-10-13T10:00:00Z',
      stopped_reported_at: null,
      stopped_received_at: null,
      stop_reason: null,
    };
    act(() => h.onSnapshot({ kind: 'transactions-active', rows: [row] }, 's'));
    act(() => h.onDelta({ kind: 'transactions-active', op: 'remove', transaction_id: 7 }, 'stop'));
    expect(result.current.snapshot).toMatchObject({ rows: [] });
  });
});
