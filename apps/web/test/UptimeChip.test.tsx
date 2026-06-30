// Tests for the operational uptime chip on the detail page header.
// What we cover:
//   - loading → success transition renders the formatted % and tone class
//   - error path renders the —-state badge
//   - clicking the chip toggles the details popover; the popover
//     surfaces the interval list + a window switcher that refetches

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UptimeResponse } from '@/api/uptime-client';

// fetchCpUptime mock. Each test sets `nextResponse` (or `nextError`)
// for the upcoming call, then asserts the rendered output.
const nextResponse: { value: UptimeResponse | null } = { value: null };
const nextError: { value: Error | null } = { value: null };
const fetchCalls: Array<{ cpId: string; from: string; to: string }> = [];

vi.mock('@/api/uptime-client', () => ({
  fetchCpUptime: async (
    _token: string,
    cpId: string,
    params: { from: string; to: string },
  ): Promise<UptimeResponse> => {
    fetchCalls.push({ cpId, from: params.from, to: params.to });
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

import { UptimeChip } from '@/components/UptimeChip';

beforeEach(() => {
  nextResponse.value = null;
  nextError.value = null;
  fetchCalls.length = 0;
});

afterEach(() => cleanup());

function _response(over: Partial<UptimeResponse> = {}): UptimeResponse {
  return {
    cp_id: 'CP_001',
    uptime_pct: 99.95,
    offline_seconds_total: 0,
    online_seconds_total: 2_592_000,
    intervals: [],
    window: { from: '2026-04-13T00:00:00Z', to: '2026-05-13T00:00:00Z', seconds: 2_592_000 },
    ...over,
  };
}

describe('UptimeChip — rendering', () => {
  it('shows a loading badge before the fetch resolves', () => {
    nextResponse.value = _response();
    render(<UptimeChip cpId="CP_001" />);
    // The loading branch carries the spinner + the word "uptime".
    expect(screen.getByTestId('uptime-chip')).toHaveTextContent('uptime');
  });

  it('renders the formatted percentage in the success state', async () => {
    nextResponse.value = _response({ uptime_pct: 99.95 });
    render(<UptimeChip cpId="CP_001" />);

    await waitFor(() => {
      expect(screen.getByTestId('uptime-chip')).toHaveTextContent('uptime: 99.95% (30d)');
    });
  });

  it('renders the dash error state when the fetch rejects', async () => {
    nextError.value = new Error('upstream 502');
    render(<UptimeChip cpId="CP_001" />);

    await waitFor(() => {
      expect(screen.getByTestId('uptime-chip')).toHaveTextContent('uptime: —');
    });
    // Detail surfaces in the title attribute so the operator can
    // hover for the upstream message.
    expect(screen.getByTestId('uptime-chip')).toHaveAttribute('title', 'upstream 502');
  });
});

describe('UptimeChip — popover + window switcher', () => {
  it('opens a popover on click with the interval breakdown', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response({
      uptime_pct: 95.83,
      offline_seconds_total: 3600,
      online_seconds_total: 82_800,
      intervals: [
        {
          went_offline_at: '2026-05-12T10:00:00Z',
          came_online_at: '2026-05-12T11:00:00Z',
          offline_seconds: 3600,
          prior_reason: 'clean',
        },
      ],
      window: { from: '2026-05-12T00:00:00Z', to: '2026-05-13T00:00:00Z', seconds: 86_400 },
    });
    render(<UptimeChip cpId="CP_001" />);
    await waitFor(() => expect(screen.getByTestId('uptime-chip')).toHaveTextContent('95.83%'));

    await user.click(screen.getByTestId('uptime-chip'));

    expect(screen.getByTestId('uptime-chip-popover')).toBeInTheDocument();
    // Interval shows up with its reason + clipped times. The chip
    // translates the gateway's raw `clean` into operator-friendly
    // copy; the title attribute carries the full explanation.
    expect(screen.getByText(/reason: graceful disconnect/i)).toBeInTheDocument();
  });

  it('shows "no outages" when the interval list is empty', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<UptimeChip cpId="CP_001" />);
    await waitFor(() => expect(screen.getByTestId('uptime-chip')).toHaveTextContent('99.95%'));

    await user.click(screen.getByTestId('uptime-chip'));
    expect(screen.getByText(/No outages in this window/i)).toBeInTheDocument();
  });

  it('refetches when the window switcher changes the days', async () => {
    const user = userEvent.setup();
    nextResponse.value = _response();
    render(<UptimeChip cpId="CP_001" />);
    await waitFor(() => expect(fetchCalls.length).toBe(1));

    await user.click(screen.getByTestId('uptime-chip'));
    nextResponse.value = _response({ uptime_pct: 98.0 });
    await act(async () => {
      await user.click(screen.getByTestId('uptime-window-7'));
    });

    await waitFor(() => expect(fetchCalls.length).toBe(2));
    // Two windows means two distinct from/to pairs sent to the
    // gateway — the proxy doesn't normalize, so each click is a
    // fresh request.
    const [first, second] = fetchCalls;
    expect(first.from).not.toBe(second.from);
  });
});
