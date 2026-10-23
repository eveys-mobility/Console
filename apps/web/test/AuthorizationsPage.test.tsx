// AuthorizationsPage: the operator's one-stop "why isn't my charger
// coming up" page. Two sections — the gateway's own pending-
// authorization queue (actionable: Authorize) and the chargers the
// TOGER backend keeps answering `Pending` at BootNotification
// (read-only: fix is in the panel, not here).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listAuthorizationsSpy = vi.fn();
const authorizeDeviceSpy = vi.fn();
const listChargePointsSpy = vi.fn();

vi.mock('@/api/authorizations-client', () => ({
  listAuthorizations: (...args: unknown[]) => listAuthorizationsSpy(...args),
  authorizeDevice: (...args: unknown[]) => authorizeDeviceSpy(...args),
}));
vi.mock('@/api/charge-points-client', () => ({
  listChargePoints: (...args: unknown[]) => listChargePointsSpy(...args),
}));
vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: { rpc: vi.fn(), subscribe: vi.fn(), close: vi.fn(), connect: vi.fn() },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    let href = to;
    for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, String(v));
    return (
      <a href={href} data-testid="router-link">
        {children}
      </a>
    );
  },
}));

import { AuthorizationsPage } from '@/pages/AuthorizationsPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthorizationsPage />
    </QueryClientProvider>,
  );
}

const pendingAuth = {
  cp_id: 'NEW_DEVICE_1',
  first_seen_at: '2026-10-23T09:00:00+00:00',
  last_seen_at: '2026-10-23T09:05:00+00:00',
  peer_ip: '10.0.0.1',
  user_agent: null,
  vendor: null,
  model: null,
  firmware: null,
  serial_number: null,
  attempts: 3,
};

const backendPendingRow = {
  cp_id: 'SN20052210130151',
  online: true,
  pod_id: 'pod-1',
  vendor: 'EN+',
  model: 'DC120K-E2-B2',
  firmware_version: '1.1.670',
  serial_number: 'SN20052210130151',
  last_boot_at: '2026-10-22T17:01:00+00:00',
  last_heartbeat_at: null,
  last_status: null,
  connectors: [],
  last_boot_status: 'Pending',
  last_boot_reason: 'backend_pending',
  last_boot_decided_at: '2026-10-22T17:01:00+00:00',
};

beforeEach(() => {
  listAuthorizationsSpy.mockReset();
  authorizeDeviceSpy.mockReset();
  listChargePointsSpy.mockReset();
  listAuthorizationsSpy.mockResolvedValue([pendingAuth]);
  listChargePointsSpy.mockResolvedValue({ charge_points: [], unavailable: false });
});

afterEach(() => cleanup());

describe('AuthorizationsPage — operator pending queue (unchanged)', () => {
  it('lists the gateway pending set with an Authorize action', async () => {
    renderPage();
    expect(await screen.findByText('NEW_DEVICE_1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
  });
});

describe('AuthorizationsPage — waiting for backend registration', () => {
  it('asks the Console server for chargers whose last boot is Pending', async () => {
    renderPage();
    await screen.findByText('NEW_DEVICE_1');
    expect(listChargePointsSpy).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ last_boot_status: 'Pending' }),
    );
  });

  it('lists backend-pending chargers read-only, linking to the detail page', async () => {
    listChargePointsSpy.mockResolvedValue({
      charge_points: [backendPendingRow],
      unavailable: false,
    });
    renderPage();
    const section = await screen.findByTestId('backend-pending-section');
    expect(within(section).getByText('Waiting for backend registration')).toBeInTheDocument();
    const link = within(section).getByRole('link', { name: 'SN20052210130151' });
    expect(link).toHaveAttribute('href', '/inspect/charge-points/SN20052210130151');
    expect(within(section).getByText(/not defined in the TOGER panel/i)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Authorize' })).toBeNull();
  });

  it('shows an empty hint when no charger is held by the backend', async () => {
    renderPage();
    const section = await screen.findByTestId('backend-pending-section');
    expect(
      await within(section).findByText(/No charger is waiting on the backend/i),
    ).toBeInTheDocument();
  });

  it('lists nothing when the gateway ignores the filter and returns rows without a boot status', async () => {
    const { last_boot_status: _status, ...withoutStatus } = backendPendingRow;
    listChargePointsSpy.mockResolvedValue({ charge_points: [withoutStatus], unavailable: false });
    renderPage();
    const section = await screen.findByTestId('backend-pending-section');
    expect(
      await within(section).findByText(/No charger is waiting on the backend/i),
    ).toBeInTheDocument();
    expect(within(section).queryByRole('link', { name: 'SN20052210130151' })).toBeNull();
  });

  it('says so when the Console server could not reach the gateway', async () => {
    listChargePointsSpy.mockResolvedValue({ charge_points: [], unavailable: true });
    renderPage();
    const section = await screen.findByTestId('backend-pending-section');
    expect(await within(section).findByText(/gateway unavailable/i)).toBeInTheDocument();
  });
});
