// Component tests for FleetPage. The page has enough state worth
// covering: snapshot rendering, delta application, view-mode (table
// vs grid + the phone force-grid override), client-side filters
// (search + status), server-side filter param passthrough, and
// the cursor-stack pagination.
//
// We stub the transport layer (use-subscription, ws-context) and
// the breakpoint hook so each test can drive page state directly.
// The router is also stubbed because mounting RouterProvider for a
// single page is heavy; we only verify <Link>'s `to` and
// `params` get the right values.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChargePointSummary } from '@eveys-console/protocol';

// ---- mocks ---------------------------------------------------------------

// Capture every subscription call so tests can assert on params.
const subscriptionCalls: { query: string; params: Record<string, unknown> }[] = [];

// Per-test override of what the subscription returns.
type SubResult = {
  loading?: boolean;
  error?: string | null;
  snapshot?: {
    kind: 'charge-points';
    rows: ChargePointSummary[];
    next_cursor?: string | null;
  } | null;
  lastDelta?: unknown;
  cursor?: string | null;
};
let nextSubResult: SubResult = {};

vi.mock('@/hooks/use-subscription', () => ({
  useSubscription: (query: string, params: Record<string, unknown>) => {
    subscriptionCalls.push({ query, params: { ...params } });
    return {
      loading: false,
      error: null,
      snapshot: null,
      lastDelta: null,
      cursor: null,
      ...nextSubResult,
    };
  },
}));

let isPhone = false;
vi.mock('@/lib/use-breakpoint', () => ({
  useIsBelow: () => isPhone,
}));

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: {
      rpc: vi.fn(),
      subscribe: vi.fn(),
      close: vi.fn(),
      connect: vi.fn(),
    },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

// Minimal router stub: <Link to="..." params={...}> renders <a> with
// a stable testid + href. `useSearch` returns a snapshot of a tiny
// pub/sub store so navigate() updates trigger consumer re-renders
// (real TanStack does this via its internal store; we mimic the
// observable shape).
const routerSearch: { faults?: boolean } = {};
const navigateCalls: Array<Record<string, unknown>> = [];
const searchListeners = new Set<() => void>();
let searchSnapshot: { faults?: boolean } = {};
function applySearchMutation(mutate: (current: { faults?: boolean }) => { faults?: boolean }) {
  const next = mutate({ ...routerSearch });
  for (const k of Object.keys(routerSearch)) delete routerSearch[k as keyof typeof routerSearch];
  Object.assign(routerSearch, next);
  searchSnapshot = { ...routerSearch };
  for (const fn of searchListeners) fn();
}

vi.mock('@tanstack/react-router', async () => {
  // We need useSyncExternalStore for the search-store mock. Pull it
  // from React directly inside the factory so the mock is self-
  // contained.
  const { useSyncExternalStore } = await import('react');
  return {
    Link: ({
      to,
      params,
      children,
      className,
      title,
    }: {
      to: string;
      params?: Record<string, unknown>;
      children: React.ReactNode;
      className?: string;
      title?: string;
    }) => {
      let href = to;
      if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) {
          href = href.replace(`$${k}`, String(v));
        }
      }
      return (
        <a href={href} data-testid="router-link" className={className} title={title}>
          {children}
        </a>
      );
    },
    useSearch: () =>
      useSyncExternalStore(
        (cb: () => void) => {
          searchListeners.add(cb);
          return () => searchListeners.delete(cb);
        },
        () => searchSnapshot,
      ),
    useNavigate: () => (opts: { search?: unknown; replace?: boolean }) => {
      navigateCalls.push(opts as Record<string, unknown>);
      if (typeof opts.search === 'function') {
        applySearchMutation(opts.search as (current: { faults?: boolean }) => { faults?: boolean });
      } else if (opts.search && typeof opts.search === 'object') {
        applySearchMutation((cur) => ({ ...cur, ...(opts.search as Record<string, unknown>) }));
      }
    },
  };
});

// ---- imports under test --------------------------------------------------

import { FleetPage } from '@/pages/FleetPage';

// ---- fixtures ------------------------------------------------------------

const baseRow = (
  cp_id: string,
  overrides: Partial<ChargePointSummary> = {},
): ChargePointSummary => ({
  cp_id,
  online: true,
  pod_id: 'pod-1',
  vendor: 'Eveys',
  model: 'Eveys-22kW-AC',
  firmware_version: '1.0.0',
  serial_number: cp_id,
  last_boot_at: '2026-05-09T10:00:00+00:00',
  last_heartbeat_at: '2026-05-09T11:00:00+00:00',
  last_status: 'Available',
  connectors: [
    {
      connector_id: 1,
      status: 'Available',
      error_code: 'NoError',
      last_changed_at: '2026-05-09T11:00:00Z',
    },
  ],
  ...overrides,
});

beforeEach(() => {
  subscriptionCalls.length = 0;
  nextSubResult = {};
  isPhone = false;
  // Reset the URL/navigate stubs between tests.
  for (const k of Object.keys(routerSearch)) delete routerSearch[k as keyof typeof routerSearch];
  searchSnapshot = {};
  navigateCalls.length = 0;
  // Each test gets a fresh localStorage for the view-mode pref.
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// ---- helpers -------------------------------------------------------------

// Find a <select> by the visible text of its currently-selected
// option, optionally narrowing by an option label that must also
// be present in the same select. The page has multiple selects and
// two of them default to "Any" (OCPP version + Status), so a sole
// current-text query is ambiguous; passing `containsOption` picks
// the right one by checking for a discriminator option inside.
function selectByCurrentText(
  text: string | RegExp,
  containsOption?: string | RegExp,
): HTMLSelectElement {
  const selects = document.querySelectorAll('select');
  for (const sel of Array.from(selects)) {
    const opt = sel.options[sel.selectedIndex];
    if (!opt) continue;
    const t = opt.textContent ?? '';
    const match = typeof text === 'string' ? t === text : text.test(t);
    if (!match) continue;
    if (containsOption !== undefined) {
      const has = Array.from(sel.options).some((o) => {
        const v = o.textContent ?? '';
        return typeof containsOption === 'string' ? v === containsOption : containsOption.test(v);
      });
      if (!has) continue;
    }
    return sel;
  }
  throw new Error(`No <select> found with selected option matching ${String(text)}`);
}

// ---- tests ---------------------------------------------------------------

describe('FleetPage — initial states', () => {
  it('renders a loading state while the subscription is pending', () => {
    nextSubResult = { loading: true, snapshot: null };
    render(<FleetPage />);
    expect(screen.getByText(/Loading charge points/i)).toBeInTheDocument();
  });

  it('renders an error alert when the subscription errors', () => {
    nextSubResult = { error: 'gateway 500', snapshot: null };
    render(<FleetPage />);
    expect(screen.getByText(/Couldn't load charge points/i)).toBeInTheDocument();
    expect(screen.getByText('gateway 500')).toBeInTheDocument();
  });

  it('renders an empty state when the snapshot is empty', () => {
    nextSubResult = { snapshot: { kind: 'charge-points', rows: [], next_cursor: null } };
    render(<FleetPage />);
    expect(screen.getByText(/No charge points match the current filters/i)).toBeInTheDocument();
  });
});

describe('FleetPage — snapshot rendering', () => {
  it('renders one row per charger in table view', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A'), baseRow('CP_B'), baseRow('CP_C', { online: false })],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    const links = screen.getAllByTestId('router-link');
    const cpLinks = links.filter((a) =>
      a.getAttribute('href')?.startsWith('/inspect/charge-points/'),
    );
    expect(cpLinks.map((a) => a.textContent)).toEqual(['CP_A', 'CP_B', 'CP_C']);
    // Heading shows "Charge points" with no total until the snapshot carries one.
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/Charge points/);
  });

  it('heading shows the server-reported total when the snapshot carries one', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 873,
      },
    };
    render(<FleetPage />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/873 total/);
  });

  it('renders pod_id (truncated) for online chargers and an em-dash for offline', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          baseRow('CP_ON', { pod_id: 'pod-deadbeef-12345' }),
          baseRow('CP_OFF', { online: false, pod_id: null }),
        ],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    // Online charger: pod cell shows the truncated pod_id with full value on title.
    const onlineRow = screen.getByText('CP_ON').closest('tr')! as HTMLTableRowElement;
    const podCell = onlineRow.cells[3]!;
    expect(podCell).toHaveTextContent('pod-dead');
    expect(within(podCell).getByTitle('pod-deadbeef-12345')).toBeInTheDocument();

    // Offline charger: em-dash placeholder.
    const offlineRow = screen.getByText('CP_OFF').closest('tr')! as HTMLTableRowElement;
    expect(offlineRow.cells[3]!).toHaveTextContent('—');
  });

  it('renders an uptime cell for online chargers and an em-dash for offline', () => {
    // Anchor "now" so the formatted uptime is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          baseRow('CP_ON_BOOT', {
            online: true,
            last_boot_at: '2026-05-10T09:46:00.000Z', // 2h 14m before now
          }),
          baseRow('CP_OFF_NOBOOT', { online: false, last_boot_at: null }),
        ],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    const onRow = screen.getByText('CP_ON_BOOT').closest('tr')! as HTMLTableRowElement;
    // Cells: [chevron, cp_id, online, pod, last status, connectors, vendor/model, firmware, OCPP, last heartbeat, uptime]
    expect(onRow.cells[10]!).toHaveTextContent('2h 14m');

    const offRow = screen.getByText('CP_OFF_NOBOOT').closest('tr')! as HTMLTableRowElement;
    expect(offRow.cells[10]!).toHaveTextContent('—');
    vi.useRealTimers();
  });
});

describe('FleetPage — view toggle', () => {
  it('starts in table view by default and switches to grid on click', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);
    // Table view → there's a column header named "cp_id"
    expect(screen.getByRole('columnheader', { name: 'cp_id' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /grid view/i }));
    expect(screen.queryByRole('columnheader', { name: 'cp_id' })).not.toBeInTheDocument();
  });

  it('forces grid view below sm and hides the toggle', () => {
    isPhone = true;
    // Even if the user previously saved table view…
    localStorage.setItem('eveys-console.fleet-view', 'table');
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);
    // …the table doesn't render on phone.
    expect(screen.queryByRole('columnheader', { name: 'cp_id' })).not.toBeInTheDocument();
    // And the toggle is hidden.
    expect(screen.queryByRole('button', { name: /grid view/i })).not.toBeInTheDocument();
  });
});

describe('FleetPage — client-side filters', () => {
  it('search box debounces the typed value into cp_id_contains on the next subscribe', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_BERLIN_001')],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;

    await user.type(screen.getByPlaceholderText(/e.g. 617b5675/i), '617b5675');
    // Debounced commit (250ms). Flush the timer.
    await vi.advanceTimersByTimeAsync(300);

    const last = subscriptionCalls.at(-1);
    expect(last?.params.cp_id_contains).toBe('617b5675');
    vi.useRealTimers();
  });

  it('faults-only filter narrows to chargers with fault or advisory severity', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          // ok
          baseRow('CP_OK'),
          // fault: connector status=Faulted
          baseRow('CP_FAULT', {
            connectors: [
              {
                connector_id: 1,
                status: 'Faulted',
                error_code: 'GroundFailure',
                last_changed_at: '2026-05-09T11:00:00Z',
              },
            ],
          }),
          // advisory: error_code != NoError on a non-Faulted connector
          baseRow('CP_ADV', {
            connectors: [
              {
                connector_id: 1,
                status: 'Available',
                error_code: 'WeakSignal',
                last_changed_at: '2026-05-09T11:00:00Z',
              },
            ],
          }),
        ],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    // All three visible before filter.
    expect(screen.getByText('CP_OK')).toBeInTheDocument();
    expect(screen.getByText('CP_FAULT')).toBeInTheDocument();
    expect(screen.getByText('CP_ADV')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /faults only/i }));

    expect(screen.queryByText('CP_OK')).not.toBeInTheDocument();
    expect(screen.getByText('CP_FAULT')).toBeInTheDocument();
    expect(screen.getByText('CP_ADV')).toBeInTheDocument();
  });

  it('status select pushes last_status into subscription params', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;

    const statusSelect = selectByCurrentText(/Any/, 'Charging');
    await user.selectOptions(statusSelect, 'Charging');

    const last = subscriptionCalls.at(-1);
    expect(last?.params.last_status).toBe('Charging');
  });
});

describe('FleetPage — server-side filter passthrough', () => {
  it('online select pushes online: true into subscription params', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;

    // Online select's default visible text is "All"; pick it that way.
    await user.selectOptions(selectByCurrentText('All'), 'online');

    // After the change the most recent subscription call should
    // carry online: true.
    const last = subscriptionCalls.at(-1);
    expect(last?.params.online).toBe(true);
  });

  it('vendor input commits to subscription params on Enter', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;

    // The Vendor field is an <input list="vendor-options">
    // identifiable by its placeholder.
    const vendor = screen.getByPlaceholderText('any');
    await user.click(vendor);
    await user.keyboard('Eveys{Enter}');

    const last = subscriptionCalls.at(-1);
    expect(last?.params.vendor).toBe('Eveys');
  });

  it('ocpp version select pushes ocpp_version into subscription params', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;

    // The OCPP select has a unique aria-label, which keeps it
    // distinguishable from the Status select that also defaults to
    // "Any".
    const ocppSelect = screen.getByLabelText('OCPP version');
    await user.selectOptions(ocppSelect, 'ocpp1.6');

    const last = subscriptionCalls.at(-1);
    expect(last?.params.ocpp_version).toBe('ocpp1.6');
  });

  it('selecting OCPP "Any" removes ocpp_version from subscription params', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: { kind: 'charge-points', rows: [baseRow('CP_A')], next_cursor: null },
    };
    render(<FleetPage />);

    const ocppSelect = screen.getByLabelText('OCPP version');
    await user.selectOptions(ocppSelect, 'ocpp1.6');
    subscriptionCalls.length = 0;
    await user.selectOptions(ocppSelect, 'all');

    const last = subscriptionCalls.at(-1);
    // No ocpp_version key when filter is "Any" — the page omits
    // unset filters from the params rather than sending an empty
    // string, so the gateway's no-filter path is exercised.
    expect(last?.params.ocpp_version).toBeUndefined();
  });

  it('changing page-size resets to page 1 and updates page_size param', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 250,
      },
    };
    render(<FleetPage />);
    // Advance to page 2.
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    // Now changing page-size resets to page 1.
    subscriptionCalls.length = 0;
    await user.selectOptions(screen.getByDisplayValue('100'), '50');
    const last = subscriptionCalls.at(-1);
    expect(last?.params.page).toBe(1);
    expect(last?.params.page_size).toBe(50);
  });
});

describe('FleetPage — pagination', () => {
  it('Next increments the page param', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 250,
      },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(subscriptionCalls.at(-1)?.params.page).toBe(2);
  });

  it('Previous is disabled on page 1 and enabled on page 2+', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 250,
      },
    };
    render(<FleetPage />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('button', { name: /previous/i })).not.toBeDisabled();
  });

  it('Next is disabled on the last page (page == pageCount)', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 50, // single page
      },
    };
    render(<FleetPage />);
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('Last page button jumps to the final page', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
        page: 1,
        page_size: 100,
        total: 873,
      },
    };
    render(<FleetPage />);
    subscriptionCalls.length = 0;
    await user.click(screen.getByRole('button', { name: /last page/i }));
    expect(subscriptionCalls.at(-1)?.params.page).toBe(9);
  });
});

describe('FleetPage — delta application', () => {
  it('upsert delta replaces a snapshot row in place', () => {
    // Snapshot has the charger Available with a Faulted connector;
    // the delta flips the charger's last_status to Charging. The
    // assertion targets the "last status" column (third <td>) so
    // it's not confused by the connector-status pill in the
    // "connectors" column.
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          baseRow('CP_A', {
            last_status: 'Available',
            connectors: [
              {
                connector_id: 1,
                status: 'Faulted',
                error_code: 'NoError',
                last_changed_at: '2026-05-09T11:00:00Z',
              },
            ],
          }),
        ],
        next_cursor: null,
      },
      lastDelta: {
        kind: 'charge-points',
        op: 'upsert',
        row: baseRow('CP_A', {
          last_status: 'Charging',
          connectors: [
            {
              connector_id: 1,
              status: 'Faulted',
              error_code: 'NoError',
              last_changed_at: '2026-05-09T11:00:00Z',
            },
          ],
        }),
      },
    };
    render(<FleetPage />);
    const link = screen.getByText('CP_A');
    const dataRow = link.closest('tr')! as HTMLTableRowElement;
    // Cells in order: [chevron, cp_id, online, pod, last status, connectors, vendor/model, firmware, last heartbeat]
    const lastStatusCell = dataRow.cells[4]!;
    expect(within(lastStatusCell).getByText('Charging')).toBeInTheDocument();
    expect(within(lastStatusCell).queryByText('Available')).not.toBeInTheDocument();
  });

  it('upsert delta adds a row that was not in the snapshot', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A')],
        next_cursor: null,
      },
      lastDelta: {
        kind: 'charge-points',
        op: 'upsert',
        row: baseRow('CP_NEW'),
      },
    };
    render(<FleetPage />);
    expect(screen.getByText('CP_NEW')).toBeInTheDocument();
  });

  it('remove delta drops a row from the page', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_A'), baseRow('CP_B')],
        next_cursor: null,
      },
      lastDelta: { kind: 'charge-points', op: 'remove', cp_id: 'CP_A' },
    };
    render(<FleetPage />);
    expect(screen.queryByText('CP_A')).not.toBeInTheDocument();
    expect(screen.getByText('CP_B')).toBeInTheDocument();
  });
});

describe('FleetPage — table-row connector drill-down', () => {
  it('expanding a row reveals connector detail', async () => {
    const user = userEvent.setup();
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          baseRow('CP_A', {
            connectors: [
              {
                connector_id: 1,
                status: 'Charging',
                error_code: 'NoError',
                last_changed_at: '2026-05-09T11:00:00Z',
              },
              {
                connector_id: 2,
                status: 'Faulted',
                error_code: 'GroundFailure',
                last_changed_at: '2026-05-09T11:00:00Z',
              },
            ],
          }),
        ],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    // Connector detail isn't rendered yet.
    expect(screen.queryByText('GroundFailure')).not.toBeInTheDocument();

    // The expand button has aria-label "Expand"
    await user.click(screen.getAllByRole('button', { name: /expand/i })[0]!);

    expect(screen.getByText('GroundFailure')).toBeInTheDocument();
  });
});

describe('FleetPage — links', () => {
  it('cp_id link points at /inspect/charge-points/$cpId', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_TEST_ABC')],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    const link = screen.getByText('CP_TEST_ABC').closest('a')!;
    expect(link.getAttribute('href')).toBe('/inspect/charge-points/CP_TEST_ABC');
  });
});

describe('FleetPage — ?faults=1 URL param', () => {
  it('arrives with the Faults-only toggle pre-engaged when ?faults=1 is set', () => {
    applySearchMutation(() => ({ faults: true }));
    const rows: ChargePointSummary[] = [
      baseRow('cp_a', {
        last_status: 'Faulted',
        connectors: [
          {
            connector_id: 1,
            status: 'Faulted',
            error_code: 'GroundFailure',
            last_changed_at: '2026-05-09T11:00:00Z',
          },
        ],
      }),
      baseRow('cp_b'),
    ];
    nextSubResult = {
      loading: false,
      snapshot: { kind: 'charge-points', rows, next_cursor: null },
      lastDelta: null,
    };
    render(<FleetPage />);
    const toggle = screen.getByRole('button', { name: /faults only/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // Only the faulted row should be visible in the table.
    expect(screen.queryByText('cp_a')).toBeTruthy();
    expect(screen.queryByText('cp_b')).toBeFalsy();
  });

  it('toggling Faults-only off clears the ?faults search param', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    applySearchMutation(() => ({ faults: true }));
    nextSubResult = {
      loading: false,
      snapshot: { kind: 'charge-points', rows: [baseRow('cp_a')], next_cursor: null },
      lastDelta: null,
    };
    render(<FleetPage />);
    const toggle = screen.getByRole('button', { name: /faults only/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(routerSearch.faults).toBeUndefined();
    expect(navigateCalls.length).toBeGreaterThan(0);
    expect(navigateCalls[navigateCalls.length - 1]?.replace).toBe(true);
  });

  it('clicking Faults-only when off sets ?faults=1', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    nextSubResult = {
      loading: false,
      snapshot: { kind: 'charge-points', rows: [baseRow('cp_a')], next_cursor: null },
      lastDelta: null,
    };
    render(<FleetPage />);
    const toggle = screen.getByRole('button', { name: /faults only/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(routerSearch.faults).toBe(true);
  });
});

// Suppress an `act()` warning that fires on the cleanup of tests
// using userEvent + the `<datalist>` autocomplete on the Vendor
// input. The warning is benign; jsdom doesn't fully model
// datalist-related events.
beforeEach(() => {
  const original = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (msg.includes('not wrapped in act(') || msg.includes('was not wrapped')) return;
    original(...(args as []));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FleetPage — OCPP version column', () => {
  it('renders the formatted ocpp_version in the table row when present', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [
          baseRow('CP_A', { ocpp_version: 'ocpp1.6' }),
          baseRow('CP_B', { ocpp_version: 'ocpp2.0.1' }),
        ],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    const cells = screen.getAllByTestId('fleet-row-ocpp-version');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent('OCPP 1.6');
    expect(cells[1]).toHaveTextContent('OCPP 2.0.1');
  });

  it('falls back to "—" when ocpp_version is null (older row)', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-points',
        rows: [baseRow('CP_OLD', { ocpp_version: null })],
        next_cursor: null,
      },
    };
    render(<FleetPage />);
    expect(screen.getByTestId('fleet-row-ocpp-version')).toHaveTextContent('—');
  });
});
