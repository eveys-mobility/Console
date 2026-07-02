// Focused tests for header behaviours on ChargerDetailPage: snapshot /
// delta merge, the Commands tab, and the OCPP version badge. Other
// parts of the page (status pills, fault banner, transactions history,
// statistics card, device events panel) are covered by their own
// component tests; we mock those out so this file stays scoped.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChargePointSummary } from '@eveys-console/protocol';

import { ToastProvider } from '@/components/ui/toaster';
import { ThemeProvider } from '@/lib/theme-context';

const rpcSpy = vi.fn<(method: string, params: Record<string, unknown>) => Promise<void>>();
rpcSpy.mockResolvedValue();

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: { rpc: rpcSpy, subscribe: vi.fn(), close: vi.fn(), connect: vi.fn() },
    status: 'open',
    diagnostics: { lastCloseCode: null, lastCloseReason: null, reconnectAttempt: 0 },
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

// Route param: ChargerDetailPage reads cpId via useParams.
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ cpId: 'cp_TEST' }),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

// Mock the heavyweight child panels — each has its own test file.
vi.mock('@/components/CommandsConsole', () => ({
  CommandsConsole: () => <div data-testid="mock-commands-console" />,
}));
vi.mock('@/components/DeviceEventsPanel', () => ({
  DeviceEventsPanel: () => <div data-testid="mock-device-events" />,
}));
vi.mock('@/components/DiagnosticsHistory', () => ({
  DiagnosticsHistory: () => <div data-testid="mock-diagnostics" />,
}));
vi.mock('@/components/StatisticsCard', () => ({
  StatisticsCard: () => <div data-testid="mock-stats" />,
}));
vi.mock('@/components/TransactionsHistory', () => ({
  TransactionsHistory: () => <div data-testid="mock-transactions" />,
}));

let isPhone = false;
vi.mock('@/lib/use-breakpoint', () => ({
  useIsBelow: () => isPhone,
}));

// Per-test override of what the subscription returns.
interface SubResult {
  loading?: boolean;
  error?: string | null;
  snapshot?: { kind: 'charge-point'; row: ChargePointSummary } | null;
  lastDelta?: unknown;
}
let nextSubResult: SubResult = {};

vi.mock('@/hooks/use-subscription', () => ({
  useSubscription: () => ({
    loading: false,
    error: null,
    snapshot: null,
    lastDelta: null,
    cursor: null,
    ...nextSubResult,
  }),
}));

import { ChargerDetailPage } from '@/pages/ChargerDetailPage';

function baseCp(over: Partial<ChargePointSummary> = {}): ChargePointSummary {
  return {
    cp_id: 'cp_TEST',
    online: true,
    pod_id: 'pod-1',
    vendor: 'Eveys',
    model: 'Eveys-22kW-AC',
    firmware_version: '1.0.0',
    serial_number: 'cp_TEST',
    last_boot_at: '2026-05-10T10:00:00+00:00',
    last_heartbeat_at: '2026-05-10T11:48:00+00:00',
    last_status: 'Available',
    connectors: [
      { connector_id: 1, status: 'Available', error_code: 'NoError', last_changed_at: null },
    ],
    ...over,
  };
}

function withProviders(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ToastProvider>{node}</ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function renderPage() {
  return render(withProviders(<ChargerDetailPage />));
}

// Commands moved to a tab in the detail-page refactor; helper opens
// it so the existing assertions on the Hard-Reset / RemoteStart
// controls keep working without each test re-implementing the click.
async function openCommandsTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('detail-tab-commands'));
}

beforeEach(() => {
  rpcSpy.mockClear();
  isPhone = false;
  nextSubResult = {};
});

afterEach(() => {
  cleanup();
});

describe('ChargerDetailPage — snapshot / lastDelta merge', () => {
  // Regression: the page used to render `sub.snapshot.row` directly,
  // so a fresh cp.boot / cp.status delta never showed up until the
  // next snapshot refresh. The detail page now merges `lastDelta` in.
  it('renders the lastDelta row (fresh BootNotification / StatusNotification) over the snapshot', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-point',
        row: baseCp({ firmware_version: '1.0.0', last_status: 'Available' }),
      },
      lastDelta: {
        kind: 'charge-point',
        row: baseCp({ firmware_version: '2.5.0', last_status: 'Charging' }),
      },
    };
    renderPage();
    expect(screen.getByText(/firmware 2\.5\.0/)).toBeInTheDocument();
    expect(screen.queryByText(/firmware 1\.0\.0/)).toBeNull();
  });
});

describe('ChargerDetailPage — Commands tab', () => {
  it('Commands tab renders the inline CommandsConsole', async () => {
    const user = userEvent.setup();
    nextSubResult = { snapshot: { kind: 'charge-point', row: baseCp() } };
    renderPage();
    await openCommandsTab(user);
    expect(screen.getByTestId('mock-commands-console')).toBeInTheDocument();
  });
});

describe('ChargerDetailPage — OCPP version badge', () => {
  it('renders an OCPP version badge when the row carries ocpp_version', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-point',
        row: baseCp({ ocpp_version: 'ocpp1.6' }),
      },
    };
    renderPage();
    const badge = screen.getByTestId('header-ocpp-version');
    expect(badge).toHaveTextContent('OCPP 1.6');
  });

  it('omits the badge when ocpp_version is null (older row, gateway not yet recorded it)', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-point',
        row: baseCp({ ocpp_version: null }),
      },
    };
    renderPage();
    expect(screen.queryByTestId('header-ocpp-version')).toBeNull();
  });

  it('renders ocpp2.0.1 verbatim as "OCPP 2.0.1" when that profile lands', () => {
    nextSubResult = {
      snapshot: {
        kind: 'charge-point',
        row: baseCp({ ocpp_version: 'ocpp2.0.1' }),
      },
    };
    renderPage();
    expect(screen.getByTestId('header-ocpp-version')).toHaveTextContent('OCPP 2.0.1');
  });
});
