import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertCircle, BellRing, Loader2 } from 'lucide-react';
import { useMemo } from 'react';

import type { ChargePointSummary, TransactionSummary } from '@eveys-console/protocol';

import { fetchAggregate } from '@/api/analytics-client';
import { fetchSysKpis } from '@/api/kpis-client';
import { fetchSysStatus } from '@/api/sys-client';
import { MetricTile } from '@/components/MetricTile';
import { ServiceStatusPills } from '@/components/ServiceStatusPills';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { useFiringAlerts } from '@/hooks/use-firing-alerts';
import { useSilences } from '@/hooks/use-silences';
import { useSubscription } from '@/hooks/use-subscription';
import { countFaults } from '@/lib/fault';
import { useConsoleClient } from '@/lib/ws-context';

// Dashboard layout (top → bottom):
//   1. Heading + last-refresh hint
//   2. Alerts summary card — firing count by severity + link to /sys/alerts
//      (no list of individual alerts; that's what /sys/alerts is for)
//   3. KPI tiles — six headline counts in one row of /sys/kpis
//   4. Services pills — gateway / Kafka / WS broker state
//
// The previous version inlined a client-derived AlertsPanel that
// expanded into one row per offline device, which blows up on real
// fleets and duplicates what /sys/alerts already renders better. We
// keep the summary, drop the list.

export function SystemPage() {
  const { token } = useConsoleClient();
  const sysQuery = useQuery({
    queryKey: ['sys-status'],
    queryFn: () => fetchSysStatus(token!),
    refetchInterval: 5_000,
    enabled: !!token,
  });

  // Gateway-side rollup. One round-trip on a 10 s cadence — faster
  // than the legacy 30 s firing-alerts poll because the tiles are
  // what the operator's eyes land on first, but slower than the 5 s
  // /sys/status poll so we don't hammer the gateway over counts.
  const kpisQuery = useQuery({
    queryKey: ['sys-kpis'],
    queryFn: () => fetchSysKpis(token!),
    refetchInterval: 10_000,
    enabled: !!token,
  });

  // Fallback for the 24h-energy tile when the gateway's /sys/kpis
  // doesn't include `energy_24h_wh` (older gateway deploy — the
  // rollup lives on a newer version of the endpoint). The
  // /sys/transactions/aggregate endpoint has been shipping longer,
  // so summing the last 24 h of hourly buckets gets us the same
  // number without needing a gateway redeploy. Wall-clock window,
  // computed at query time — TanStack Query caches by the stable
  // key `['sys-24h-energy-fallback']` and refetches every 60 s.
  const energy24hFallback = useQuery({
    queryKey: ['sys-24h-energy-fallback'],
    queryFn: async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
      const resp = await fetchAggregate(token!, {
        from: from.toISOString(),
        to: to.toISOString(),
        bucket: 'hour',
        group_by: 'none',
      });
      return resp.buckets.reduce((sum, b) => sum + b.consumed_wh_total, 0);
    },
    refetchInterval: 60_000,
    enabled: !!token,
  });

  // Fallbacks: the gateway might not yet have /sys/kpis deployed.
  // Keep the client-side counts running so the page degrades to the
  // pre-refactor numbers when `kpis.unavailable === true`.
  const cpSub = useSubscription('charge-points', { limit: 500 });
  const cpRows: ChargePointSummary[] =
    cpSub.snapshot && cpSub.snapshot.kind === 'charge-points' ? cpSub.snapshot.rows : [];
  const txSub = useSubscription('transactions-active', {});
  const activeTxRows: TransactionSummary[] =
    txSub.snapshot && txSub.snapshot.kind === 'transactions-active' ? txSub.snapshot.rows : [];

  const firing = useFiringAlerts();
  const silences = useSilences();
  const severityCounts = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let info = 0;
    for (const a of firing.alerts) {
      if (a.severity === 'critical') critical++;
      else if (a.severity === 'warning') warning++;
      else info++;
    }
    return { critical, warning, info };
  }, [firing.alerts]);

  if (sysQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading system status…
      </div>
    );
  }
  if (sysQuery.error || !sysQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>System status unavailable</AlertTitle>
        <AlertDescription>
          {sysQuery.error instanceof Error ? sysQuery.error.message : 'unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  const sys = sysQuery.data;
  const kpis = kpisQuery.data;
  const kpisUnavailable = !kpis || kpis.unavailable;

  // Prefer gateway counts; fall back to client-side aggregation when
  // the rollup endpoint isn't available yet (older gateway deploy or
  // transient upstream failure).
  const onlineCount =
    kpis?.online_count ?? (cpSub.loading ? null : cpRows.filter((cp) => cp.online).length);
  const totalCount = kpis?.total_count ?? (cpSub.loading ? null : cpRows.length);
  const activeSessions = kpis?.active_tx_count ?? (txSub.loading ? null : activeTxRows.length);
  const faults = countFaults(cpRows);
  const faultsCount = kpis?.faulted_count ?? (cpSub.loading ? null : faults.fault);
  const txToday = kpis?.tx_today_count ?? null;
  const energy24h = kpis?.energy_24h_wh ?? energy24hFallback.data ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">System status</h2>
        <p className="text-sm text-muted-foreground">
          Live; counts refresh every 10 seconds, service pings every 5.
        </p>
      </div>

      <section className="space-y-2" data-testid="service-status-row">
        <ServiceStatusPills sys={sys} />
      </section>

      <AlertsSummaryCard
        critical={severityCounts.critical}
        warning={severityCounts.warning}
        info={severityCounts.info}
        silencedCount={silences.silences.length}
        unavailable={firing.unavailable}
        {...(firing.reason ? { unavailableReason: firing.reason } : {})}
        loading={firing.loading}
      />

      <section
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        data-testid="metrics-row"
      >
        <MetricTile
          testId="metric-chargers"
          label="Chargers online"
          value={onlineCount === null ? '…' : String(onlineCount)}
          hint={totalCount === null ? 'loading…' : `of ${totalCount} known`}
          tone={
            onlineCount !== null && totalCount !== null && totalCount > 0 && onlineCount === 0
              ? 'warning'
              : 'default'
          }
          to="/inspect/charge-points"
        />
        <MetricTile
          testId="metric-sessions"
          label="Active sessions"
          value={activeSessions === null ? '…' : String(activeSessions)}
          hint={
            activeSessions === null
              ? 'loading…'
              : activeSessions === 1
                ? '1 charger charging'
                : `${activeSessions} chargers charging`
          }
          tone={activeSessions !== null && activeSessions > 0 ? 'success' : 'default'}
          to="/inspect/transactions"
        />
        <MetricTile
          testId="metric-faults"
          label="Faults"
          value={faultsCount === null ? '…' : String(faultsCount)}
          hint={
            faultsCount === null
              ? 'loading…'
              : faults.advisory > 0
                ? `${faults.advisory} advisory`
                : 'no advisories'
          }
          tone={(faultsCount ?? 0) > 0 ? 'danger' : faults.advisory > 0 ? 'warning' : 'default'}
          to="/inspect/charge-points"
          search={{ faults: true }}
        />
        <MetricTile
          testId="metric-tx-today"
          label="Transactions today"
          value={txToday === null ? (kpisUnavailable ? '—' : '…') : String(txToday)}
          hint={
            txToday === null
              ? kpisUnavailable
                ? 'gateway rollup unavailable'
                : 'loading…'
              : 'since UTC midnight'
          }
          to="/inspect/transactions"
        />
        <MetricTile
          testId="metric-energy"
          label="24h energy"
          value={
            energy24h === null ? (energy24hFallback.isPending ? '…' : '—') : formatKwh(energy24h)
          }
          hint={energy24h === null ? 'rollup unavailable' : 'last 24h'}
        />
        <MetricTile
          testId="metric-alerts"
          label="Firing alerts"
          value={
            firing.unavailable
              ? '—'
              : firing.loading
                ? '…'
                : String(severityCounts.critical + severityCounts.warning + severityCounts.info)
          }
          hint={
            firing.unavailable
              ? firing.reason === 'unreachable'
                ? 'Alertmanager unreachable'
                : 'Alertmanager not configured'
              : `${severityCounts.critical} critical · ${severityCounts.warning} warning`
          }
          tone={
            severityCounts.critical > 0
              ? 'danger'
              : severityCounts.warning > 0
                ? 'warning'
                : 'default'
          }
          to="/sys/alerts"
        />
      </section>
    </div>
  );
}

function formatKwh(wh: number): string {
  const kwh = wh / 1000;
  if (kwh < 10) return `${kwh.toFixed(1)} kWh`;
  if (kwh < 1000) return `${kwh.toFixed(0)} kWh`;
  return `${(kwh / 1000).toFixed(1)} MWh`;
}

// Compact at-a-glance summary card linking to /sys/alerts for detail.
// Shows the severity breakdown so the operator can tell at a glance
// whether to drop everything (critical) or read it later (warning /
// info). No list of individual alerts — that's what the dedicated
// /sys/alerts page is for.
function AlertsSummaryCard({
  critical,
  warning,
  info,
  silencedCount,
  unavailable,
  unavailableReason,
  loading,
}: {
  critical: number;
  warning: number;
  info: number;
  silencedCount: number;
  unavailable: boolean;
  unavailableReason?: 'not_configured' | 'unreachable';
  loading: boolean;
}) {
  const total = critical + warning + info;
  // Tone the icon amber on `unreachable` so the operator notices a
  // wired-but-broken upstream, rather than dismissing it as the same
  // "no Alertmanager configured" neutral state.
  const isUnreachable = unavailable && unavailableReason === 'unreachable';
  return (
    <Link
      to="/sys/alerts"
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="alerts-summary-card"
    >
      <Card className="transition-colors hover:border-primary/40 hover:bg-muted/40">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <BellRing
              className={
                critical > 0 && !unavailable
                  ? 'h-5 w-5 text-destructive'
                  : warning > 0 && !unavailable
                    ? 'h-5 w-5 text-amber-500'
                    : isUnreachable
                      ? 'h-5 w-5 text-amber-500'
                      : 'h-5 w-5 text-muted-foreground'
              }
            />
            <div>
              <p className="text-sm font-medium">Alertmanager</p>
              <p className="text-xs text-muted-foreground">
                {loading
                  ? 'loading…'
                  : unavailable
                    ? isUnreachable
                      ? 'unreachable — check the Alertmanager pod or ALERTMANAGER_URL'
                      : 'not configured — set ALERTMANAGER_URL on the Console'
                    : total === 0 && silencedCount === 0
                      ? 'all clear — no alerts firing'
                      : total === 0
                        ? `0 firing · ${silencedCount} silenced`
                        : `${critical} critical · ${warning} warning · ${info} info${silencedCount > 0 ? ` · ${silencedCount} silenced` : ''}`}
              </p>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">Open alerts →</span>
        </CardContent>
      </Card>
    </Link>
  );
}
