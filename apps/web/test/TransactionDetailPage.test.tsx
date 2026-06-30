// Component tests for TransactionDetailPage. The page composes a
// header card, two charts (kW + cumulative kWh), a per-phase snapshot
// card, and an optional SoC card. We stub the transactions REST client
// so each test can drive the page state directly. Recharts'
// LineChart is replaced with a div that captures the `data` prop on
// `data-points` so we can assert on the data shape Recharts will
// receive without rendering svg.
//
// Router is stubbed because mounting RouterProvider for one page is
// heavy; we only check that <Link> renders the right href.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ---------------------------------------------------------------

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: {
      rpc: vi.fn(),
      // The page wires `useInvalidateOnCpEvents` to refresh meter-value
      // queries when a `cp.meter` event arrives. The hook calls
      // `client.subscribe(...).then(...)` — return a resolved handle so
      // the polling-only tests don't crash on the WS path they don't
      // exercise.
      subscribe: vi.fn(() => Promise.resolve({ unsubscribe: () => undefined })),
      close: vi.fn(),
      connect: vi.fn(),
    },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

const fetchTransaction = vi.fn();
const fetchMeterValues = vi.fn();
vi.mock('@/api/transactions-client', () => ({
  fetchTransaction: (...args: unknown[]) => fetchTransaction(...args),
  fetchMeterValues: (...args: unknown[]) => fetchMeterValues(...args),
}));

let routeParams: { txId: string } = { txId: '42' };
vi.mock('@tanstack/react-router', () => ({
  useParams: () => routeParams,
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: Record<string, unknown>;
    children: React.ReactNode;
    className?: string;
  }) => {
    let href = to;
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        href = href.replace(`$${k}`, String(v));
      }
    }
    return (
      <a href={href} data-testid="router-link" className={className}>
        {children}
      </a>
    );
  },
}));

// Replace Recharts with stand-ins. `LineChart` writes its `data` prop
// to `data-points`; the rest are no-ops so a normal <LineChart/> JSX
// tree renders without exploding inside jsdom.
vi.mock('recharts', () => {
  const noop = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    LineChart: ({ data, children }: { data: unknown; children?: React.ReactNode }) => (
      <div data-testid="line-chart" data-points={JSON.stringify(data)}>
        {children}
      </div>
    ),
    ResponsiveContainer: noop,
    CartesianGrid: noop,
    XAxis: noop,
    YAxis: noop,
    Tooltip: noop,
    Legend: noop,
    Line: ({ dataKey, name }: { dataKey?: string; name?: string }) => (
      <div data-testid="line" data-key={dataKey} data-name={name} />
    ),
  };
});

// ---- imports under test --------------------------------------------------

import { TransactionDetailPage } from '@/pages/TransactionDetailPage';
import type { TransactionDetail, MeterValuesResponse } from '@/api/transactions-client';

// ---- helpers -------------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TransactionDetailPage />
    </QueryClientProvider>,
  );
}

const closedTx: TransactionDetail = {
  transaction_id: 42,
  cp_id: 'CP_A',
  connector_id: 1,
  id_tag: 'TAG_BLUE',
  meter_start_wh: 1_000,
  meter_stop_wh: 6_500,
  started_at: '2026-05-10T12:00:00.000Z',
  stopped_at: '2026-05-10T13:00:00.000Z',
  stop_reason: 'Local',
  open: false,
  telemetry: {
    soc: { start: 30, last: 80, delta: 50 },
    phases: {
      L1: {
        voltage_v: 230,
        current_a: 10,
        power_w: 2300,
        power_factor: 0.99,
        occurred_at: '2026-05-10T12:30:00.000Z',
      },
      L2: {
        voltage_v: 231,
        current_a: 9.8,
        power_w: 2263,
        power_factor: 0.99,
        occurred_at: '2026-05-10T12:30:00.000Z',
      },
      L3: {
        voltage_v: 230,
        current_a: 10.1,
        power_w: 2323,
        power_factor: 0.99,
        occurred_at: '2026-05-10T12:30:00.000Z',
      },
    },
  },
};

const emptyMeterValues: MeterValuesResponse = { meter_values: [], next_cursor: null };

beforeEach(() => {
  routeParams = { txId: '42' };
  fetchTransaction.mockReset();
  fetchMeterValues.mockReset();
  fetchMeterValues.mockResolvedValue(emptyMeterValues);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- tests ---------------------------------------------------------------

describe('TransactionDetailPage — initial states', () => {
  it('renders a loading state while the detail fetch is pending', () => {
    fetchTransaction.mockReturnValue(new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText(/Loading transaction/i)).toBeInTheDocument();
  });

  it('renders an error alert when the detail fetch rejects', async () => {
    fetchTransaction.mockRejectedValue(new Error('gateway 502'));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load transaction 42/i)).toBeInTheDocument();
    });
    expect(screen.getByText('gateway 502')).toBeInTheDocument();
  });

  it('rejects an invalid tx_id with a friendly alert', async () => {
    routeParams = { txId: 'abc' };
    renderPage();
    expect(screen.getByText(/Invalid transaction id/i)).toBeInTheDocument();
    // No fetch should have happened.
    expect(fetchTransaction).not.toHaveBeenCalled();
  });
});

describe('TransactionDetailPage — header rendering', () => {
  it('renders the closed-tx header fields and computes kWh from meter_start/stop', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    renderPage();
    await waitFor(() => screen.getByText(/tx 42/));

    // tx id + status badge.
    expect(screen.getByText('tx 42')).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();

    // cp_id link points at the charger detail.
    const cpLink = screen.getByText('CP_A').closest('a')!;
    expect(cpLink.getAttribute('href')).toBe('/inspect/charge-points/CP_A');

    // kWh is computed: (6500 - 1000) / 1000 = 5.500
    expect(screen.getByText(/kWh: 5\.500/)).toBeInTheDocument();

    // stop_reason badge present.
    expect(screen.getByText(/reason: Local/)).toBeInTheDocument();
  });

  it('renders an "open" badge for an open tx and shows a kWh em-dash when meter_stop is null', async () => {
    fetchTransaction.mockResolvedValue({
      ...closedTx,
      open: true,
      meter_stop_wh: null,
      stopped_at: null,
      stop_reason: null,
    });
    renderPage();
    await waitFor(() => screen.getByText('open'));
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText(/kWh: —/)).toBeInTheDocument();
  });
});

describe('TransactionDetailPage — phases card', () => {
  it('renders one row per phase present in telemetry.phases', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    renderPage();
    await waitFor(() => screen.getByTestId('phases-list'));
    expect(screen.getByTestId('phase-row-L1')).toBeInTheDocument();
    expect(screen.getByTestId('phase-row-L2')).toBeInTheDocument();
    expect(screen.getByTestId('phase-row-L3')).toBeInTheDocument();
    // 1-phase case.
  });

  it('renders only the phases the charger reported', async () => {
    const onePhase: TransactionDetail = {
      ...closedTx,
      telemetry: {
        soc: closedTx.telemetry!.soc,
        phases: {
          L1: closedTx.telemetry!.phases.L1!,
        },
      },
    };
    fetchTransaction.mockResolvedValue(onePhase);
    renderPage();
    await waitFor(() => screen.getByTestId('phase-row-L1'));
    expect(screen.queryByTestId('phase-row-L2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phase-row-L3')).not.toBeInTheDocument();
  });

  it('renders a "no phase telemetry" placeholder when telemetry is null', async () => {
    fetchTransaction.mockResolvedValue({ ...closedTx, telemetry: null });
    renderPage();
    await waitFor(() => screen.getByText(/No phase telemetry available/i));
    expect(screen.queryByTestId('phases-list')).not.toBeInTheDocument();
  });
});

describe('TransactionDetailPage — SoC card', () => {
  it('renders the SoC card when telemetry.soc.last is non-null', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    renderPage();
    await waitFor(() => screen.getByTestId('soc-card'));
    const card = screen.getByTestId('soc-card');
    expect(within(card).getByText(/State of Charge/)).toBeInTheDocument();
    expect(within(card).getByText(/30\.0%/)).toBeInTheDocument(); // start
    expect(within(card).getByText(/80\.0%/)).toBeInTheDocument(); // last
    expect(within(card).getByText(/\+50\.0%/)).toBeInTheDocument(); // delta with sign
  });

  it('hides the SoC card when telemetry is null', async () => {
    fetchTransaction.mockResolvedValue({ ...closedTx, telemetry: null });
    renderPage();
    await waitFor(() => screen.getByText(/tx 42/));
    expect(screen.queryByTestId('soc-card')).not.toBeInTheDocument();
  });

  it('hides the SoC card when telemetry.soc.last is null', async () => {
    const noSoc: TransactionDetail = {
      ...closedTx,
      telemetry: {
        soc: { start: null, last: null, delta: null },
        phases: closedTx.telemetry!.phases,
      },
    };
    fetchTransaction.mockResolvedValue(noSoc);
    renderPage();
    await waitFor(() => screen.getByText(/tx 42/));
    expect(screen.queryByTestId('soc-card')).not.toBeInTheDocument();
  });
});

describe('TransactionDetailPage — charts', () => {
  it('passes one Power.Active.Import data point per timestamp, with per-phase columns', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    fetchMeterValues.mockImplementation(
      async (_token: string, _cp: string, params: { measurand?: string }) => {
        if (params.measurand === 'Power.Active.Import') {
          return {
            meter_values: [
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:00:30Z',
                measurand: 'Power.Active.Import',
                phase: 'L1',
                unit: 'W',
                value: 2300,
              },
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:00:30Z',
                measurand: 'Power.Active.Import',
                phase: 'L2',
                unit: 'W',
                value: 2263,
              },
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:00:30Z',
                measurand: 'Power.Active.Import',
                phase: 'L3',
                unit: 'W',
                value: 2323,
              },
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:01:00Z',
                measurand: 'Power.Active.Import',
                phase: 'L1',
                unit: 'W',
                value: 2310,
              },
            ],
            next_cursor: null,
          };
        }
        return emptyMeterValues;
      },
    );

    renderPage();
    // Only the power chart has samples; the energy chart renders an
    // empty-state placeholder. So one <line-chart> is on screen.
    await waitFor(() => {
      expect(screen.getAllByTestId('line-chart').length).toBe(1);
    });
    const charts = screen.getAllByTestId('line-chart');
    const powerData = JSON.parse(charts[0]!.getAttribute('data-points')!);
    // Two distinct timestamps → two rows.
    expect(powerData).toHaveLength(2);
    // First row has all three phases.
    expect(powerData[0].L1).toBeCloseTo(2.3);
    expect(powerData[0].L2).toBeCloseTo(2.263);
    expect(powerData[0].L3).toBeCloseTo(2.323);
    // Second row has only L1.
    expect(powerData[1].L1).toBeCloseTo(2.31);
    expect(powerData[1].L2).toBeUndefined();
  });

  it('passes one Energy.Active.Import.Register point per sample to the energy chart', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    fetchMeterValues.mockImplementation(
      async (_token: string, _cp: string, params: { measurand?: string }) => {
        if (params.measurand === 'Energy.Active.Import.Register') {
          return {
            meter_values: [
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:00:00Z',
                measurand: 'Energy.Active.Import.Register',
                phase: null,
                unit: 'Wh',
                value: 1000,
              },
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T12:30:00Z',
                measurand: 'Energy.Active.Import.Register',
                phase: null,
                unit: 'Wh',
                value: 4000,
              },
              {
                cp_id: 'CP_A',
                connector_id: 1,
                transaction_id: 42,
                occurred_at: '2026-05-10T13:00:00Z',
                measurand: 'Energy.Active.Import.Register',
                phase: null,
                unit: 'Wh',
                value: 6500,
              },
            ],
            next_cursor: null,
          };
        }
        return emptyMeterValues;
      },
    );

    renderPage();
    // Only the energy chart has samples; the power chart renders an
    // empty-state placeholder. So one <line-chart> is on screen.
    await waitFor(() => {
      expect(screen.getAllByTestId('line-chart').length).toBe(1);
    });
    const charts = screen.getAllByTestId('line-chart');
    const energyData = JSON.parse(charts[0]!.getAttribute('data-points')!);
    expect(energyData).toHaveLength(3);
    // Wh → kWh
    expect(energyData[0].kwh).toBeCloseTo(1.0);
    expect(energyData[1].kwh).toBeCloseTo(4.0);
    expect(energyData[2].kwh).toBeCloseTo(6.5);
  });

  it('shows an empty-state placeholder when no power samples are returned', async () => {
    fetchTransaction.mockResolvedValue(closedTx);
    // both queries resolve to empty
    fetchMeterValues.mockResolvedValue(emptyMeterValues);
    renderPage();
    await waitFor(() => screen.getAllByText(/No samples in this window/i));
    expect(screen.getAllByText(/No samples in this window/i).length).toBe(2);
  });
});

describe('TransactionDetailPage — open-tx polling', () => {
  it('refetches the detail on the open-tx interval and stops once closed', async () => {
    vi.useFakeTimers();
    const openTx = { ...closedTx, open: true, meter_stop_wh: null, stopped_at: null };
    fetchTransaction.mockResolvedValue(openTx);

    renderPage();
    // Initial fetch.
    await vi.waitFor(() => expect(fetchTransaction).toHaveBeenCalledTimes(1));

    // Advance past the 5 s open-tx polling cadence.
    await vi.advanceTimersByTimeAsync(5_100);
    await vi.waitFor(() => expect(fetchTransaction.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
