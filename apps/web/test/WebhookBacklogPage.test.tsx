// Component tests for WebhookBacklogPage.
//
// The page composes counts cards + a tab switch + a table of rows +
// bulk / per-row mutation buttons. Tests here cover the wiring:
//
// * initial load hits the dead tab and shows the returned rows,
// * switching to the live tab re-queries with dead=false,
// * counts card values follow the two independent count queries,
// * per-row Replay triggers a confirm + POST + refetch,
// * per-row Purge triggers a confirm + DELETE + refetch,
// * bulk "Replay all dead" is disabled at zero dead and enabled otherwise.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebhookBacklogListResponse, WebhookBacklogRow } from '@/api/webhook-backlog-client';

vi.mock('@/lib/ws-context', () => ({
  useConsoleClient: () => ({
    client: {
      rpc: vi.fn(),
      subscribe: vi.fn(() => Promise.resolve({ unsubscribe: () => undefined })),
      close: vi.fn(),
      connect: vi.fn(),
    },
    status: 'open',
    token: 'test-token',
    setToken: vi.fn(),
  }),
}));

const listMock = vi.fn();
const replayMock = vi.fn();
const purgeMock = vi.fn();
const bulkReplayMock = vi.fn();
vi.mock('@/api/webhook-backlog-client', () => ({
  listWebhookBacklog: (...args: unknown[]) => listMock(...args),
  replayWebhookBacklog: (...args: unknown[]) => replayMock(...args),
  purgeWebhookBacklog: (...args: unknown[]) => purgeMock(...args),
  replayDeadWebhookBacklog: (...args: unknown[]) => bulkReplayMock(...args),
}));

import { WebhookBacklogPage } from '@/pages/WebhookBacklogPage';

function row(over: Partial<WebhookBacklogRow> = {}): WebhookBacklogRow {
  return {
    id: over.id ?? 'row-1',
    event_id: over.event_id ?? 'evt-1',
    event_type: over.event_type ?? 'cp.boot',
    url: over.url ?? 'https://backend.example/webhooks/cp-boot',
    signature: over.signature ?? 'sha256=x',
    created_at: over.created_at ?? '2026-07-01T12:00:00Z',
    next_attempt_at: over.next_attempt_at ?? '2026-07-01T12:05:00Z',
    attempts: over.attempts ?? 1,
    last_error: over.last_error ?? 'http_500',
    dead: over.dead ?? true,
  };
}

function response(rows: WebhookBacklogRow[]): WebhookBacklogListResponse {
  return { rows, next_cursor: null };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, gcTime: 0, staleTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WebhookBacklogPage />
    </QueryClientProvider>,
  );
}

// listWebhookBacklog is called several times per render (dead count, live
// count, list-for-current-tab). Route the responses by inspecting the
// params argument.
function stubList(perCall: {
  deadCount: WebhookBacklogRow[];
  liveCount: WebhookBacklogRow[];
  deadList: WebhookBacklogRow[];
  liveList: WebhookBacklogRow[];
}) {
  listMock.mockImplementation(
    async (_token: string, params: { dead?: boolean; limit?: number }) => {
      // The counts queries use limit=500; the list query uses limit=200.
      if (params.limit === 500 && params.dead === true) return response(perCall.deadCount);
      if (params.limit === 500 && params.dead === false) return response(perCall.liveCount);
      if (params.dead === true) return response(perCall.deadList);
      return response(perCall.liveList);
    },
  );
}

beforeEach(() => {
  listMock.mockReset();
  replayMock.mockReset();
  purgeMock.mockReset();
  bulkReplayMock.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---- initial load --------------------------------------------------------

describe('WebhookBacklogPage — initial load', () => {
  it('renders dead-letter rows on default (dead) tab', async () => {
    const dead = row({ id: 'dead-1', event_type: 'cp.boot', dead: true });
    stubList({
      deadCount: [dead],
      liveCount: [],
      deadList: [dead],
      liveList: [],
    });

    renderPage();

    await waitFor(() => screen.getByTestId('backlog-row-dead-1'));
    expect(screen.getByTestId('backlog-row-dead-1')).toBeInTheDocument();
    // Dead-letter summary card shows the count.
    const summary = screen.getByTestId('dead-summary');
    expect(within(summary).getByText('1')).toBeInTheDocument();
  });

  it('empties out cleanly when nothing is in the backlog', async () => {
    stubList({ deadCount: [], liveCount: [], deadList: [], liveList: [] });
    renderPage();
    await waitFor(() => screen.getByText(/No dead-letter rows/i));
    expect(screen.getByText(/No dead-letter rows/i)).toBeInTheDocument();
  });
});

// ---- tab switch ----------------------------------------------------------

describe('WebhookBacklogPage — tabs', () => {
  it('switching to Live tab re-queries with dead=false', async () => {
    const live = row({ id: 'live-1', dead: false, attempts: 2 });
    stubList({
      deadCount: [],
      liveCount: [live],
      deadList: [],
      liveList: [live],
    });

    renderPage();
    await waitFor(() => screen.getByText(/No dead-letter rows/i));
    await userEvent.setup().click(screen.getByTestId('tab-live'));

    await waitFor(() => screen.getByTestId('backlog-row-live-1'));
    // Live rows show "retrying…" instead of Replay/Purge buttons.
    const row1 = screen.getByTestId('backlog-row-live-1');
    expect(within(row1).getByText(/retrying/i)).toBeInTheDocument();
  });
});

// ---- per-row Replay ------------------------------------------------------

describe('WebhookBacklogPage — Replay', () => {
  it('prompts for confirm and POSTs the row id', async () => {
    const dead = row({ id: 'dead-42' });
    stubList({
      deadCount: [dead],
      liveCount: [],
      deadList: [dead],
      liveList: [],
    });
    replayMock.mockResolvedValue({ ...dead, dead: false });
    // Auto-accept the confirm dialog.
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();
    await waitFor(() => screen.getByTestId('backlog-row-dead-42'));

    const row1 = screen.getByTestId('backlog-row-dead-42');
    const replayButton = within(row1).getByText(/Replay/i);
    await userEvent.setup().click(replayButton);

    expect(spy).toHaveBeenCalled();
    await waitFor(() => expect(replayMock).toHaveBeenCalledWith('test-token', 'dead-42'));
    spy.mockRestore();
  });

  it('does nothing when the confirm is dismissed', async () => {
    const dead = row({ id: 'dead-43' });
    stubList({
      deadCount: [dead],
      liveCount: [],
      deadList: [dead],
      liveList: [],
    });
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderPage();
    await waitFor(() => screen.getByTestId('backlog-row-dead-43'));

    const row1 = screen.getByTestId('backlog-row-dead-43');
    await userEvent.setup().click(within(row1).getByText(/Replay/i));

    expect(spy).toHaveBeenCalled();
    expect(replayMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---- per-row Purge -------------------------------------------------------

describe('WebhookBacklogPage — Purge', () => {
  it('prompts and DELETEs the row id', async () => {
    const dead = row({ id: 'dead-9' });
    stubList({
      deadCount: [dead],
      liveCount: [],
      deadList: [dead],
      liveList: [],
    });
    purgeMock.mockResolvedValue({ deleted: true, id: 'dead-9' });
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();
    await waitFor(() => screen.getByTestId('backlog-row-dead-9'));
    const row1 = screen.getByTestId('backlog-row-dead-9');
    await userEvent.setup().click(within(row1).getByText(/Purge/i));

    await waitFor(() => expect(purgeMock).toHaveBeenCalledWith('test-token', 'dead-9'));
    spy.mockRestore();
  });
});

// ---- bulk replay ---------------------------------------------------------

describe('WebhookBacklogPage — Replay all dead', () => {
  it('is disabled when no dead rows exist', async () => {
    stubList({ deadCount: [], liveCount: [], deadList: [], liveList: [] });
    renderPage();
    await waitFor(() => screen.getByTestId('bulk-replay'));
    expect(screen.getByTestId('bulk-replay')).toBeDisabled();
  });

  it('is enabled and calls the bulk mutation when there is one or more dead row', async () => {
    const dead = row({ id: 'dead-100' });
    stubList({
      deadCount: [dead],
      liveCount: [],
      deadList: [dead],
      liveList: [],
    });
    bulkReplayMock.mockResolvedValue({ count: 1 });
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();
    await waitFor(() => {
      const btn = screen.getByTestId('bulk-replay');
      expect(btn).not.toBeDisabled();
    });

    await userEvent.setup().click(screen.getByTestId('bulk-replay'));

    await waitFor(() => expect(bulkReplayMock).toHaveBeenCalled());
    spy.mockRestore();
  });
});
