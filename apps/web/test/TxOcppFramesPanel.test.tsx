// Tests for the per-transaction OCPP frames panel. Verifies
// (a) initial fetch hits the per-tx endpoint with the txId, (b) the
// empty-state copy shows when no frames are returned, (c) frame rows
// render with the right direction chip + action + timestamp, (d) the
// refresh button triggers a refetch, (e) clicking a row expands the
// raw_payload pretty-print pane.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OcppFrame, TxFramesParams, TxFramesResponse } from '@/api/frames-client';

const nextResponse: { value: TxFramesResponse | null } = { value: null };
const nextError: { value: Error | null } = { value: null };
const fetchCalls: Array<{ txId: number; params: TxFramesParams }> = [];

vi.mock('@/api/frames-client', () => ({
  fetchTxFrames: async (
    _token: string,
    txId: number,
    params: TxFramesParams = {},
  ): Promise<TxFramesResponse> => {
    fetchCalls.push({ txId, params: { ...params } });
    if (nextError.value) throw nextError.value;
    if (nextResponse.value) return nextResponse.value;
    throw new Error('test forgot to set nextResponse / nextError');
  },
}));

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: {
      rpc: vi.fn(),
      // useInvalidateOnCpEvents subscribes; return a resolved handle
      // so the polling-focused tests don't crash on the WS path.
      subscribe: vi.fn(() => Promise.resolve({ unsubscribe: () => undefined })),
      close: vi.fn(),
      connect: vi.fn(),
    },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

import { TxOcppFramesPanel, type TxOcppFramesPanelProps } from '@/components/TxOcppFramesPanel';

function renderPanel(props: TxOcppFramesPanelProps) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TxOcppFramesPanel {...props} />
    </QueryClientProvider>,
  );
}

function frame(overrides: Partial<OcppFrame> = {}): OcppFrame {
  return {
    event_id: 'evt-1',
    occurred_at: '2026-05-14T10:00:00Z',
    cp_id: 'CP_A',
    direction: 'inbound',
    action: 'StartTransaction',
    message_type: 2,
    message_id: 'm1',
    ocpp_version: '1.6',
    transaction_id: 42,
    raw_payload: '[2,"m1","StartTransaction",{"connectorId":1}]',
    ...overrides,
  };
}

beforeEach(() => {
  nextResponse.value = null;
  nextError.value = null;
  fetchCalls.length = 0;
});

afterEach(() => cleanup());

describe('TxOcppFramesPanel', () => {
  it('fetches frames for the given txId on mount', async () => {
    nextResponse.value = { transaction_id: 42, frames: [] };
    renderPanel({ txId: 42 });

    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0].txId).toBe(42);
    // Default limit is forwarded so the panel can't run away on a huge tx.
    expect(fetchCalls[0].params.limit).toBe(1000);
  });

  it('renders the empty-state copy when no frames are returned', async () => {
    nextResponse.value = { transaction_id: 42, frames: [] };
    renderPanel({ txId: 42 });

    await waitFor(() =>
      expect(
        screen.getByText(/No OCPP frames recorded for this transaction yet/i),
      ).toBeInTheDocument(),
    );
  });

  it('renders one row per frame with the action and time', async () => {
    nextResponse.value = {
      transaction_id: 42,
      frames: [
        frame({
          event_id: 'evt-1',
          action: 'StartTransaction',
          occurred_at: '2026-05-14T10:00:00Z',
        }),
        frame({
          event_id: 'evt-2',
          action: 'MeterValues',
          direction: 'inbound',
          occurred_at: '2026-05-14T10:01:00Z',
        }),
      ],
    };
    renderPanel({ txId: 42 });

    await waitFor(() => expect(screen.getByTestId('tx-ocpp-frames-rows')).toBeInTheDocument());
    expect(screen.getByText('StartTransaction')).toBeInTheDocument();
    expect(screen.getByText('MeterValues')).toBeInTheDocument();
    // Each row is keyed by event_id.
    expect(screen.getByTestId('tx-frame-row-evt-1')).toBeInTheDocument();
    expect(screen.getByTestId('tx-frame-row-evt-2')).toBeInTheDocument();
  });

  it('expanding a row reveals the pretty-printed raw_payload', async () => {
    nextResponse.value = {
      transaction_id: 42,
      frames: [frame()],
    };
    const user = userEvent.setup();
    renderPanel({ txId: 42 });

    await waitFor(() => expect(screen.getByTestId('tx-frame-row-evt-1')).toBeInTheDocument());
    // Pretty-printed JSON isn't visible until expanded.
    expect(screen.queryByText(/connectorId/)).not.toBeInTheDocument();

    await user.click(screen.getByTestId('tx-frame-row-evt-1'));

    await waitFor(() => expect(screen.getByText(/connectorId/)).toBeInTheDocument());
  });

  it('clicking the refresh button triggers a new fetch', async () => {
    nextResponse.value = { transaction_id: 42, frames: [] };
    const user = userEvent.setup();
    renderPanel({ txId: 42 });
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    nextResponse.value = { transaction_id: 42, frames: [frame()] };
    await user.click(screen.getByTestId('tx-ocpp-frames-refresh'));

    await waitFor(() => expect(fetchCalls.length).toBe(2));
  });

  it('renders the error state when the fetch rejects', async () => {
    nextError.value = new Error('upstream 502');
    renderPanel({ txId: 42 });

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load frames/i)).toBeInTheDocument();
      expect(screen.getByText(/upstream 502/)).toBeInTheDocument();
    });
  });
});
