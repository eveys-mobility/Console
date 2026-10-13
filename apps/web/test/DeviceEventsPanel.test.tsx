// Component tests for DeviceEventsPanel. The panel is a thin wrapper
// around useSubscription + a local 200-row ring, so the tests stub
// useSubscription and drive the ring by re-rendering with new
// `lastDelta` values. We assert on:
//  - empty state copy + spinner role
//  - ordering (newest first)
//  - the detail toggle expands + collapses
//  - the chip variant per kind is the one Badge renders
//  - the 200-row cap drops the oldest event

import { cleanup, render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeltaForQuery, DeviceEvent } from '@eveys-console/protocol';

// The subscription mock is driven per-test: each call to the hook
// returns whatever `currentSubResult` is right now, so a test can
// re-render with a different `lastDelta` to simulate a new event
// arriving. `subscriptionCalls` captures every call so we can assert
// on the query name + params (e.g. cp_id is plumbed through).

interface SubResult {
  loading: boolean;
  error: string | null;
  snapshot: unknown;
  lastDelta: DeltaForQuery | null;
  cursor: string | null;
}

let currentSubResult: SubResult = {
  loading: false,
  error: null,
  snapshot: null,
  lastDelta: null,
  cursor: null,
};

const subscriptionCalls: { query: string; params: Record<string, unknown> }[] = [];

vi.mock('@/hooks/use-subscription', () => ({
  useSubscription: (query: string, params: Record<string, unknown>) => {
    subscriptionCalls.push({ query, params: { ...params } });
    return currentSubResult;
  },
}));

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: { rpc: vi.fn(), subscribe: vi.fn(), close: vi.fn(), connect: vi.fn() },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

import { DeviceEventsPanel } from '@/components/DeviceEventsPanel';

function makeEvent(over: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    at: over.at ?? '2026-05-10T11:59:00Z',
    kind: over.kind ?? 'status',
    summary: over.summary ?? 'Connector 1 → Available',
    detail: over.detail ?? { status: 'Available', error_code: null },
    connector_id: over.connector_id ?? 1,
  };
}

function delta(event: DeviceEvent): DeltaForQuery {
  return { kind: 'device-events', append: event };
}

function setSub(over: Partial<SubResult>) {
  currentSubResult = { ...currentSubResult, ...over };
}

beforeEach(() => {
  currentSubResult = {
    loading: false,
    error: null,
    snapshot: null,
    lastDelta: null,
    cursor: null,
  };
  subscriptionCalls.length = 0;
});

afterEach(() => cleanup());

describe('DeviceEventsPanel — wiring', () => {
  it('subscribes to device-events with the cp_id prop', () => {
    render(<DeviceEventsPanel cpId="cp_test" />);
    expect(subscriptionCalls.some((c) => c.query === 'device-events')).toBe(true);
    const call = subscriptionCalls.find((c) => c.query === 'device-events')!;
    expect(call.params).toEqual({ cp_id: 'cp_test' });
  });
});

describe('DeviceEventsPanel — empty state', () => {
  it('shows archive read failure while live events can still arrive', () => {
    setSub({
      snapshot: {
        kind: 'device-events',
        rows: [],
        history_state: 'unavailable',
        history_error: 'read_failed',
      },
    });
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText(/Event history unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No recorded events/i)).not.toBeInTheDocument();
    setSub({ lastDelta: delta(makeEvent({ summary: 'live status after archive failure' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('live status after archive failure')).toBeInTheDocument();
    expect(screen.getByText(/Event history unavailable/i)).toBeInTheDocument();
  });

  it('shows a successfully read empty history without an endless loading spinner', () => {
    setSub({
      snapshot: {
        kind: 'device-events',
        rows: [],
        history_state: 'available',
        history_error: null,
      },
    });
    render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByTestId('device-events-empty')).toHaveTextContent('No recorded events');
  });

  it('keeps the last successful rows visible when live subscription later fails', () => {
    setSub({
      snapshot: {
        kind: 'device-events',
        rows: [makeEvent({ summary: 'retained status' })],
        history_state: 'available',
      },
    });
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('retained status')).toBeInTheDocument();
    setSub({ error: 'Disconnected' });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText(/Couldn't subscribe.*Disconnected/i)).toBeInTheDocument();
    expect(screen.getByText('retained status')).toBeInTheDocument();
  });

  it('renders the waiting copy when no events have arrived', () => {
    render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByTestId('device-events-empty')).toHaveTextContent('Waiting for events');
    expect(screen.queryByTestId('device-events-list')).not.toBeInTheDocument();
  });

  it('shows an error message when the subscription fails', () => {
    setSub({ error: 'boom' });
    render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText(/Couldn't subscribe.*boom/i)).toBeInTheDocument();
  });
});

describe('DeviceEventsPanel — rows', () => {
  it('renders rows newest-first as deltas arrive', () => {
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    // First event.
    setSub({ lastDelta: delta(makeEvent({ summary: 'first', at: '2026-05-10T11:00:00Z' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    // Second event — useSubscription returns a new `lastDelta` reference,
    // which fires the effect that pushes onto the ring.
    setSub({ lastDelta: delta(makeEvent({ summary: 'second', at: '2026-05-10T11:01:00Z' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    const summaries = screen.getAllByTestId('device-events-summary').map((el) => el.textContent);
    // Newest first: 'second' before 'first'.
    expect(summaries).toEqual(['second', 'first']);
  });

  it('renders a chip per row with the variant for the kind', () => {
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);

    const kinds: DeviceEvent['kind'][] = ['boot', 'status', 'meter', 'tx-started'];
    for (const kind of kinds) {
      setSub({ lastDelta: delta(makeEvent({ kind, summary: `${kind}-row` })) });
      rerender(<DeviceEventsPanel cpId="cp_test" />);
    }

    const rows = screen.getAllByTestId('device-events-row');
    // Newest-first: tx-started, meter, status, boot.
    expect(rows).toHaveLength(4);
    const expectedClasses: Record<DeviceEvent['kind'], string> = {
      boot: 'bg-emerald-500/15',
      status: 'bg-amber-500/15',
      meter: 'bg-secondary',
      'tx-started': 'bg-primary',
    };
    const orderedKinds: DeviceEvent['kind'][] = ['tx-started', 'meter', 'status', 'boot'];
    rows.forEach((row, idx) => {
      const chip = within(row).getByTestId('device-events-chip');
      expect(chip.className).toContain(expectedClasses[orderedKinds[idx]!]);
    });
  });
});

describe('DeviceEventsPanel — detail toggle', () => {
  it('expands and collapses on click', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      lastDelta: delta(
        makeEvent({
          kind: 'meter',
          summary: 'MeterValues — 2 samples',
          detail: { sample_count: 2, primary_unit: 'WH' },
        }),
      ),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    expect(screen.queryByTestId('device-events-detail')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('device-events-toggle');
    await user.click(toggle);
    const detail = screen.getByTestId('device-events-detail');
    expect(detail).toHaveTextContent('sample_count');
    expect(detail).toHaveTextContent('2');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await user.click(toggle);
    expect(screen.queryByTestId('device-events-detail')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides the toggle when detail is empty', () => {
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ detail: {} })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.queryByTestId('device-events-toggle')).not.toBeInTheDocument();
  });
});

describe('DeviceEventsPanel — pause / clear', () => {
  it('Pause buffers incoming events; Resume flushes them', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);

    // First event before pause — visible.
    setSub({ lastDelta: delta(makeEvent({ summary: 'before-pause' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('before-pause')).toBeInTheDocument();

    // Pause; next event buffers, not visible.
    await user.click(screen.getByTestId('device-events-pause'));
    setSub({
      lastDelta: delta(makeEvent({ summary: 'during-pause', at: '2026-05-10T11:59:01Z' })),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.queryByText('during-pause')).toBeNull();

    // Resume flushes the buffered event into the visible list.
    await user.click(screen.getByTestId('device-events-resume'));
    expect(screen.getByText('during-pause')).toBeInTheDocument();
  });

  it('Clear empties the visible list', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ summary: 'one' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('one')).toBeInTheDocument();
    await user.click(screen.getByTestId('device-events-clear'));
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByTestId('device-events-empty')).toBeInTheDocument();
  });
});

describe('DeviceEventsPanel — kind filter + search', () => {
  it('kind chip toggles visibility of that kind', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ summary: 'boot-event', kind: 'boot' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      lastDelta: delta(
        makeEvent({ summary: 'status-event', kind: 'status', at: '2026-05-10T11:59:02Z' }),
      ),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('boot-event')).toBeInTheDocument();
    expect(screen.getByText('status-event')).toBeInTheDocument();

    // Turn off `boot` chip → boot row hidden.
    await user.click(screen.getByTestId('device-events-kind-boot'));
    expect(screen.queryByText('boot-event')).toBeNull();
    expect(screen.getByText('status-event')).toBeInTheDocument();
  });

  it('search box filters by substring on summary', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ summary: 'BootNotification — Eveys X1' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      lastDelta: delta(
        makeEvent({ summary: 'Connector 2 → Charging', at: '2026-05-10T11:59:03Z' }),
      ),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    await user.type(screen.getByTestId('device-events-search'), 'Charging');
    expect(screen.getByText('Connector 2 → Charging')).toBeInTheDocument();
    expect(screen.queryByText('BootNotification — Eveys X1')).toBeNull();
  });
});

describe('DeviceEventsPanel — JSON view', () => {
  it('Show JSON renders a JSON dump of the event', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      lastDelta: delta(
        makeEvent({ summary: 'json-ev', detail: { connector_id: 1, status: 'Charging' } }),
      ),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    await user.click(screen.getByTestId('device-events-toggle-json'));
    const json = screen.getByTestId('device-events-json');
    expect(json.textContent).toContain('"connector_id": 1');
    expect(json.textContent).toContain('"status": "Charging"');
  });
});

describe('DeviceEventsPanel — ring cap', () => {
  it('caps the visible rows at 500 and drops the oldest beyond', () => {
    // Render once with the empty state, then push 505 distinct deltas
    // via rerender so the effect runs each time. Each event gets a
    // unique `at` so the assertion can identify which ones survived.
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    for (let i = 0; i < 505; i++) {
      // Padding makes the lex order match the numeric order, so the
      // first event (i=0, 'evt-000') is the oldest and the last
      // (i=504, 'evt-504') is the newest.
      const tag = `evt-${String(i).padStart(3, '0')}`;
      setSub({
        lastDelta: delta(
          makeEvent({
            summary: tag,
            at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          }),
        ),
      });
      act(() => {
        rerender(<DeviceEventsPanel cpId="cp_test" />);
      });
    }

    const rows = screen.getAllByTestId('device-events-summary').map((el) => el.textContent);
    expect(rows).toHaveLength(500);
    // Newest first → 'evt-504' is at index 0.
    expect(rows[0]).toBe('evt-504');
    // Oldest five (evt-000 .. evt-004) are dropped; oldest survivor is evt-005.
    expect(rows[499]).toBe('evt-005');
    expect(rows).not.toContain('evt-000');
  });
});

describe('DeviceEventsPanel — snapshot bootstrap', () => {
  it('renders snapshot rows immediately so the panel is not empty on first open', () => {
    setSub({
      snapshot: {
        kind: 'device-events',
        rows: [
          makeEvent({ summary: 'snap-newest', at: '2026-05-10T11:30:00Z' }),
          makeEvent({ summary: 'snap-older', at: '2026-05-10T11:00:00Z' }),
        ],
      },
    });
    render(<DeviceEventsPanel cpId="cp_test" />);
    expect(screen.getByText('snap-newest')).toBeInTheDocument();
    expect(screen.getByText('snap-older')).toBeInTheDocument();
    expect(screen.queryByTestId('device-events-empty')).toBeNull();
  });

  it('orders snapshot + live events newest-first regardless of arrival order', () => {
    setSub({
      snapshot: {
        kind: 'device-events',
        rows: [makeEvent({ summary: 'snap-old', at: '2026-05-10T11:00:00Z' })],
      },
    });
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      snapshot: currentSubResult.snapshot,
      lastDelta: delta(makeEvent({ summary: 'live-new', at: '2026-05-10T12:00:00Z' })),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);
    const summaries = screen.getAllByTestId('device-events-summary').map((el) => el.textContent);
    expect(summaries).toEqual(['live-new', 'snap-old']);
  });
});

describe('DeviceEventsPanel — view modes', () => {
  it('JSON mode renders every row as a JSON block instead of pretty rows', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({
      lastDelta: delta(makeEvent({ summary: 'json-mode-ev', detail: { status: 'Charging' } })),
    });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    await user.click(screen.getByTestId('device-events-view-json'));
    const blocks = screen.getAllByTestId('device-events-json');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.textContent).toContain('"summary": "json-mode-ev"');
    // The per-row toggle controls are not rendered in JSON mode.
    expect(screen.queryByTestId('device-events-toggle')).toBeNull();
  });

  it('Compact mode renders a dense single-line row per event', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ summary: 'compact-ev' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    await user.click(screen.getByTestId('device-events-view-compact'));
    const row = screen.getByTestId('device-events-row');
    expect(row.textContent).toContain('compact-ev');
    // No expansion controls in Compact mode.
    expect(screen.queryByTestId('device-events-toggle')).toBeNull();
    expect(screen.queryByTestId('device-events-toggle-json')).toBeNull();
  });

  it('persists the chosen view mode in localStorage', async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem('eveys-console.device-events.view-mode');
    const { rerender } = render(<DeviceEventsPanel cpId="cp_test" />);
    setSub({ lastDelta: delta(makeEvent({ summary: 'persist-ev' })) });
    rerender(<DeviceEventsPanel cpId="cp_test" />);

    await user.click(screen.getByTestId('device-events-view-json'));
    expect(window.localStorage.getItem('eveys-console.device-events.view-mode')).toBe('json');
  });
});
