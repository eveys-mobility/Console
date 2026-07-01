// Per-charger transaction history card. Lives below the Connectors
// card on the device page. Polls
// `/sys/charge-points/:cp_id/transactions` every 5 seconds via
// TanStack Query — long enough that closed-row repaints don't thrash
// the table, short enough that the open-session row's duration ticks
// noticeably for an operator watching the page.
//
// Pagination is cursor-stack: TanStack returns one page of rows plus
// a `next_cursor`; we record where each page started so Previous can
// pop. Page size has a small dropdown (default 20) — the gateway
// caps the page size server-side, so anything larger silently clamps.
//
// The session-detail link (`/inspect/transactions/$txId`) is the
// only outbound nav; click-through, no inline modal. The full
// telemetry view (kW / kWh charts, meter-values table) is the
// transactions detail page's job — keeping this card list-only.

import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useState } from 'react';

import {
  fetchChargePointTransactions,
  type TransactionRow,
  type TransactionsList,
} from '@/api/transactions-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useInvalidateOnCpEvents } from '@/hooks/use-invalidate-on-cp-events';
import {
  liveTelemetryKey,
  useLiveTransactionTelemetry,
  type LiveTelemetry,
} from '@/hooks/use-live-transaction-telemetry';
import { formatAbsoluteTime, formatRelativeTime, formatUptime } from '@/lib/time';
import { useConsoleClient } from '@/lib/ws-context';

interface Props {
  cpId: string;
}

const REFETCH_MS = 5000;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function TransactionsHistory({ cpId }: Props) {
  const { token } = useConsoleClient();

  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  // Cursor stack so Previous can pop — same pattern as FleetPage uses.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  const query = useQuery<TransactionsList>({
    queryKey: ['cp-transactions', cpId, pageSize, currentCursor],
    queryFn: () => {
      const params: { limit: number; cursor?: string } = { limit: pageSize };
      if (currentCursor) params.cursor = currentCursor;
      return fetchChargePointTransactions(token ?? '', cpId, params);
    },
    refetchInterval: REFETCH_MS,
    enabled: !!token,
  });

  // Push refresh: every tx-started / tx-stopped / status event
  // arriving on the broker refetches this list so a new row appears
  // (and a completed row pivots from open → completed) within
  // ~100ms instead of waiting for the 5s poll. The poll stays on as
  // a safety net.
  useInvalidateOnCpEvents({
    cpId,
    queryKeys: [['cp-transactions', cpId]],
    kinds: ['tx-started', 'tx-stopped', 'status'],
  });

  // Subscribe to live MeterValues for the cp_id so open rows can show
  // power / SoC / consumed without waiting for the 5 s poll.
  const live = useLiveTransactionTelemetry(cpId);

  const onPageSizeChange = (n: number) => {
    setPageSize(n);
    setCursorStack([null]);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Transactions history</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : query.error ? (
          <p className="text-sm text-destructive">
            Couldn't load: {query.error instanceof Error ? query.error.message : 'unknown'}
          </p>
        ) : !query.data || query.data.transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions yet for this charger.</p>
        ) : (
          <>
            <TransactionsTable rows={query.data.transactions} live={live} />
            <Pagination
              pageSize={pageSize}
              onPageSizeChange={onPageSizeChange}
              canGoBack={cursorStack.length > 1}
              onBack={() => setCursorStack((s) => s.slice(0, -1))}
              canGoNext={!!query.data.next_cursor}
              onNext={() =>
                query.data?.next_cursor
                  ? setCursorStack((s) => [...s, query.data!.next_cursor])
                  : undefined
              }
              pageNumber={cursorStack.length}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TransactionsTable({
  rows,
  live,
}: {
  rows: TransactionRow[];
  live: Map<string, LiveTelemetry>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>tx_id</TableHead>
          <TableHead>started</TableHead>
          <TableHead>duration</TableHead>
          <TableHead>id_tag</TableHead>
          <TableHead>connector</TableHead>
          <TableHead>kWh</TableHead>
          <TableHead>kW</TableHead>
          <TableHead>SoC</TableHead>
          <TableHead>status</TableHead>
          <TableHead>stop_reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const t = row.open
            ? (live.get(liveTelemetryKey(row.connector_id, row.transaction_id)) ?? null)
            : null;
          // Closed rows use the meter-stop delta. Open rows prefer
          // the live latest_wh (post-START), falling back to the row's
          // own meter_start_wh while waiting for the first sample.
          const consumedKwh =
            row.meter_stop_wh !== null
              ? (row.meter_stop_wh - row.meter_start_wh) / 1000
              : t?.latest_wh != null
                ? Math.max(0, (t.latest_wh - row.meter_start_wh) / 1000)
                : null;
          return (
            <TableRow key={row.transaction_id} data-testid="tx-row" data-tx-id={row.transaction_id}>
              <TableCell>
                <Link
                  to="/inspect/transactions/$txId"
                  params={{ txId: String(row.transaction_id) }}
                  className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                >
                  {row.transaction_id}
                </Link>
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                title={formatAbsoluteTime(row.started_at)}
              >
                {formatRelativeTime(row.started_at)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.open
                  ? formatUptime(row.started_at)
                  : formatClosedDuration(row.started_at, row.stopped_at)}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.id_tag}</TableCell>
              <TableCell className="font-mono text-xs">{row.connector_id}</TableCell>
              <TableCell className="font-mono text-xs" data-testid="tx-row-kwh">
                {consumedKwh === null ? '—' : consumedKwh.toFixed(2)}
              </TableCell>
              <TableCell className="font-mono text-xs" data-testid="tx-row-kw">
                {row.open && t?.power_kw != null ? t.power_kw.toFixed(1) : '—'}
              </TableCell>
              <TableCell className="font-mono text-xs" data-testid="tx-row-soc">
                {row.open && t?.soc_pct != null ? `${t.soc_pct.toFixed(0)}%` : '—'}
              </TableCell>
              <TableCell>
                {row.open ? (
                  <Badge variant="success">open</Badge>
                ) : (
                  <Badge variant="muted">closed</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.stop_reason ?? ''}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

interface PaginationProps {
  pageSize: number;
  onPageSizeChange: (n: number) => void;
  canGoBack: boolean;
  onBack: () => void;
  canGoNext: boolean;
  onNext: () => void;
  pageNumber: number;
}

function Pagination({
  pageSize,
  onPageSizeChange,
  canGoBack,
  onBack,
  canGoNext,
  onNext,
  pageNumber,
}: PaginationProps) {
  return (
    <div className="mt-3 flex flex-col items-stretch gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center justify-between gap-2 sm:justify-start">
        <span>Rows per page</span>
        <Select
          value={String(pageSize)}
          onChange={(e) => onPageSizeChange(Number(e.currentTarget.value))}
          className="h-9 w-[80px] text-xs sm:h-7"
          aria-label="Rows per page"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span>Page {pageNumber}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            disabled={!canGoBack}
            className="h-9 sm:h-7"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={!canGoNext}
            className="h-9 sm:h-7"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Render the duration of a closed session as a compact "Xh Ym" /
 * "Xm Ys" / "Xs" string. Mirrors `formatUptime`'s output style so
 * open and closed rows scan the same.
 */
export function formatClosedDuration(startedAt: string, stoppedAt: string | null): string {
  if (!stoppedAt) return '—';
  const start = new Date(startedAt).getTime();
  const stop = new Date(stoppedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(stop)) return '—';
  const deltaSec = Math.max(0, Math.floor((stop - start) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) {
    const m = Math.floor(deltaSec / 60);
    const s = deltaSec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (deltaSec < 86_400) {
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(deltaSec / 86_400);
  const h = Math.floor((deltaSec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
