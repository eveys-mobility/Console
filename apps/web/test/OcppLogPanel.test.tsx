// Tests for the OCPP Log panel: loading / error / empty / rows
// states, row expansion to show pretty-printed payload, and the
// filter controls (range switcher + direction select + action
// input) forwarding the right params to the gateway proxy.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CpFramesParams, CpFramesResponse } from '@/api/frames-client';

const nextResponse: { value: CpFramesResponse | null } = { value: null };
const nextError: { value: Error | null } = { value: null };
const fetchCalls: Array<{ cpId: string; params: CpFramesParams }> = [];

vi.mock('@/api/frames-client', () => ({
  fetchCpFrames: async (
    _token: string,
    cpId: string,
    params: CpFramesParams,
  ): Promise<CpFramesResponse> => {
    fetchCalls.push({ cpId, params });
    if (nextError.value) throw nextError.value;
    if (nextResponse.value) return nextResponse.value;
    throw new Error('test forgot to set nextResponse / nextError');
  },
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

import { OcppLogPanel } from '@/components/OcppLogPanel';

beforeEach(() => {
  nextResponse.value = null;
  nextError.value = null;
  fetchCalls.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function _response(frames: CpFramesResponse['frames'] = []): CpFramesResponse {
  return { cp_id: 'CP_001', frames, request_id: 'req-1' };
}

describe('OcppLogPanel — rendering', () => {
  it('shows the loading state before the first fetch resolves', () => {
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    expect(screen.getByText(/Loading frames/i)).toBeInTheDocument();
  });

  it('shows the empty state when the response has no frames', async () => {
    nextResponse.value = _response([]);
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => {
      expect(screen.getByText(/No OCPP frames in this window/i)).toBeInTheDocument();
    });
  });

  it('renders one row per frame with direction + action + tx chip', async () => {
    nextResponse.value = _response([
      {
        event_id: 'e1',
        occurred_at: '2026-05-12T10:00:00Z',
        cp_id: 'CP_001',
        direction: 'inbound',
        action: 'MeterValues',
        message_type: 2,
        message_id: 'call-1',
        ocpp_version: 'ocpp1.6',
        transaction_id: 42,
        raw_payload: '[2,"call-1","MeterValues",{"transactionId":42}]',
      },
      {
        event_id: 'e2',
        occurred_at: '2026-05-12T10:00:05Z',
        cp_id: 'CP_001',
        direction: 'outbound',
        action: '',
        message_type: 3,
        message_id: 'call-1',
        ocpp_version: 'ocpp1.6',
        transaction_id: null,
        raw_payload: '[3,"call-1",{}]',
      },
    ]);
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => {
      expect(screen.getByTestId('ocpp-log-rows')).toBeInTheDocument();
    });
    expect(screen.getByText('MeterValues')).toBeInTheDocument();
    // tx chip only on the row that has transaction_id set
    expect(screen.getByText(/tx 42/)).toBeInTheDocument();
  });

  it('expands a frame to show the pretty-printed payload', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response([
      {
        event_id: 'e1',
        occurred_at: '2026-05-12T10:00:00Z',
        cp_id: 'CP_001',
        direction: 'inbound',
        action: 'BootNotification',
        message_type: 2,
        message_id: 'call-1',
        ocpp_version: 'ocpp1.6',
        transaction_id: null,
        raw_payload: '[2,"call-1","BootNotification",{"chargePointVendor":"ACME"}]',
      },
    ]);
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(screen.getByText('BootNotification')).toBeInTheDocument());

    await user.click(screen.getByText('BootNotification'));

    // Pretty-printed JSON contains the vendor field on its own line.
    expect(screen.getByText(/chargePointVendor/)).toBeInTheDocument();
  });

  it('renders the error state when the fetch rejects', async () => {
    nextError.value = new Error('upstream 502');
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load frames: upstream 502/i)).toBeInTheDocument();
    });
  });
});

describe('OcppLogPanel — filters', () => {
  it('refreshes the time window at request time after the panel has stayed open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T07:00:00Z'));
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    expect(fetchCalls[0].params.to).toBe('2026-10-13T07:00:00.000Z');

    vi.setSystemTime(new Date('2026-10-13T09:00:00Z'));
    await user.click(screen.getByTestId('ocpp-log-refresh'));
    await waitFor(() => expect(fetchCalls.length).toBe(2));
    expect(fetchCalls[1].params.to).toBe('2026-10-13T09:00:00.000Z');
    expect(fetchCalls[1].params.from).toBe('2026-10-13T08:00:00.000Z');
  });

  it('commits a trimmed action on blur without fetching each keystroke', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    await user.type(screen.getByTestId('ocpp-log-action-input'), '  StatusNotification  ');
    expect(fetchCalls.length).toBe(1);
    await user.tab();
    await waitFor(() => expect(fetchCalls.length).toBe(2));
    expect(fetchCalls[1].params.action).toBe('StatusNotification');
  });

  it('does not repeat an Enter commit when the unchanged input later loses focus', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));
    await user.type(screen.getByTestId('ocpp-log-action-input'), 'MeterValues{Enter}');
    await waitFor(() => expect(fetchCalls.length).toBe(2));
    await user.tab();
    expect(fetchCalls.length).toBe(2);
  });

  it('refetches with direction=outbound when the select changes', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    nextResponse.value = _response();
    await act(async () => {
      await user.selectOptions(screen.getByTestId('ocpp-log-direction'), 'outbound');
    });

    await waitFor(() => expect(fetchCalls.length).toBe(2));
    expect(fetchCalls[1].params.direction).toBe('outbound');
  });

  it('refetches when range switcher is clicked', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    nextResponse.value = _response();
    await act(async () => {
      await user.click(screen.getByTestId('ocpp-log-range-1440'));
    });

    await waitFor(() => expect(fetchCalls.length).toBe(2));
    // Distinct from/to window from the previous (default) call.
    expect(fetchCalls[0].params.from).not.toBe(fetchCalls[1].params.from);
  });

  it('commits the action filter on Enter and forwards as `action`', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<OcppLogPanel cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    nextResponse.value = _response();
    const input = screen.getByTestId('ocpp-log-action-input');
    await user.click(input);
    await user.keyboard('MeterValues{Enter}');

    await waitFor(() => expect(fetchCalls.length).toBe(2));
    expect(fetchCalls[1].params.action).toBe('MeterValues');
  });
});
