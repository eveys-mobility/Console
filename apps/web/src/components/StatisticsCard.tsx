// Per-charger statistics card. Lives between the Connectors and
// Transactions cards on the device page. Aggregates the per-cp
// transaction list into four headline tiles (total, completed,
// energy, mean duration) plus a "last session" line, with an
// All-time / 30d / 7d / 24h window selector.
//
// Why client-side aggregation: the gateway has no `/stats` endpoint
// today and the per-cp list paginates fast enough that 2,500 rows
// (5 × 500-row pages) is plenty for typical operator scale. When
// the gateway grows a real aggregation surface we'll switch the
// data source; the UI shape stays.
//
// Why 30s polling, not realtime: these are summary numbers — total
// kWh delivered, last session timestamp — that don't need to tick
// per-second. The Transactions card below already polls at 5 s for
// the live row, and a charging-active badge is on the header. Stats
// at 30 s keeps the wire cost flat.

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { fetchAllChargePointTransactions, type TransactionRow } from '@/api/transactions-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useInvalidateOnCpEvents } from '@/hooks/use-invalidate-on-cp-events';
import {
  liveTelemetryKey,
  useLiveTransactionTelemetry,
} from '@/hooks/use-live-transaction-telemetry';
import { computeStats, type ChargerStats, type StatsWindow } from '@/lib/stats';
import { formatDurationMinutes, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useConsoleClient } from '@/lib/ws-context';

interface Props {
  cpId: string;
}

const REFETCH_MS = 30_000;

const WINDOWS: { value: StatsWindow; label: string; tileSubtitle: string }[] = [
  { value: 'all', label: 'All-time', tileSubtitle: 'all-time' },
  { value: '30d', label: '30d', tileSubtitle: 'in last 30 days' },
  { value: '7d', label: '7d', tileSubtitle: 'in last 7 days' },
  { value: '24h', label: '24h', tileSubtitle: 'in last 24 hours' },
];

export function StatisticsCard({ cpId }: Props) {
  const { token } = useConsoleClient();
  const [windowChoice, setWindowChoice] = useState<StatsWindow>('all');

  const query = useQuery<{ transactions: TransactionRow[]; truncated: boolean }>({
    queryKey: ['cp-statistics', cpId],
    queryFn: () => fetchAllChargePointTransactions(token ?? '', cpId),
    refetchInterval: REFETCH_MS,
    enabled: !!token,
  });

  // Push refresh on tx-started + tx-stopped so a new session shows
  // up immediately and the completed/active counts pivot live —
  // without the 30s poll lag.
  useInvalidateOnCpEvents({
    cpId,
    queryKeys: [['cp-statistics', cpId]],
    kinds: ['tx-started', 'tx-stopped'],
  });

  // Live meter-register readings for currently-open sessions on this
  // charger. Fed into `computeStats` so the Total energy tile counts
  // delivered-so-far kWh on active sessions instead of freezing at
  // the last closed session's total.
  const live = useLiveTransactionTelemetry(cpId);

  const stats: ChargerStats | null = useMemo(() => {
    if (!query.data) return null;
    return computeStats(query.data.transactions, windowChoice, {
      currentEnergyWh: (t) =>
        live.get(liveTelemetryKey(t.connector_id, t.transaction_id))?.latest_wh ?? null,
    });
  }, [query.data, windowChoice, live]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Statistics</CardTitle>
        <WindowSelector value={windowChoice} onChange={setWindowChoice} />
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
          <p className="text-sm text-muted-foreground">No sessions yet for this charger.</p>
        ) : stats ? (
          <>
            <Tiles stats={stats} subtitle={subtitleFor(windowChoice)} />
            <p className="mt-3 text-xs text-muted-foreground">
              Last session: {formatRelativeTime(stats.lastSessionStartedAt)}
            </p>
            {query.data.truncated ? (
              <p className="mt-2 text-xs italic text-muted-foreground">
                Showing the most recent 2,500 sessions. Older sessions exist; switch the window or
                check the Transactions page.
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function subtitleFor(w: StatsWindow): string {
  return WINDOWS.find((x) => x.value === w)?.tileSubtitle ?? 'all-time';
}

function WindowSelector({
  value,
  onChange,
}: {
  value: StatsWindow;
  onChange: (next: StatsWindow) => void;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label="Statistics window">
      {WINDOWS.map((w) => (
        <Button
          key={w.value}
          variant={value === w.value ? 'default' : 'outline'}
          size="sm"
          aria-pressed={value === w.value}
          onClick={() => onChange(w.value)}
          className="h-8 text-xs"
        >
          {w.label}
        </Button>
      ))}
    </div>
  );
}

function Tiles({ stats, subtitle }: { stats: ChargerStats; subtitle: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Total sessions"
        value={String(stats.totalSessions)}
        sub={subtitle}
        testId="stat-total-sessions"
      />
      <Tile
        label="Completed"
        value={String(stats.completedSessions)}
        sub={stats.activeNow > 0 ? `${stats.activeNow} active now` : subtitle}
        testId="stat-completed"
      />
      <Tile
        label="Total energy"
        value={formatEnergy(stats.totalEnergyKwh)}
        sub={subtitle}
        testId="stat-energy"
      />
      <Tile
        label="Mean duration"
        value={
          stats.meanSessionMinutes === null
            ? '—'
            : formatDurationMinutes(stats.meanSessionMinutes * 60_000)
        }
        sub={subtitle}
        testId="stat-mean-duration"
      />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  testId?: string;
}) {
  return (
    <div className={cn('rounded-md border bg-muted/40 px-3 py-3')} data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

/**
 * Render kWh totals as `12.34 kWh` (two decimals) under 1 MWh,
 * `1.23 MWh` (two decimals) above. Anything finer than 0.01 kWh
 * rounds to zero — the chargers report Wh integers, so 0.005 kWh
 * is below the resolution we ever see.
 */
export function formatEnergy(kwh: number): string {
  if (!Number.isFinite(kwh) || kwh < 0) return '—';
  if (kwh >= 1000) return `${(kwh / 1000).toFixed(2)} MWh`;
  return `${kwh.toFixed(2)} kWh`;
}
