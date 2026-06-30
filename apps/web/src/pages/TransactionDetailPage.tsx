import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';

import {
  fetchMeterValues,
  fetchTransaction,
  type MeterValueSample,
  type PhaseSnapshot,
  type TransactionDetail,
} from '@/api/transactions-client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer } from '@/components/ui/chart';
import { TxOcppFramesPanel } from '@/components/TxOcppFramesPanel';
import { useInvalidateOnCpEvents } from '@/hooks/use-invalidate-on-cp-events';
import { formatUptime } from '@/lib/time';
import { useConsoleClient } from '@/lib/ws-context';

// OCPP-1.6 measurand wire forms. Power.Active.Import is in W (or kW
// when the charger reports kilowatt directly); the cumulative energy
// register is Energy.Active.Import.Register in Wh / kWh.
const POWER_MEASURAND = 'Power.Active.Import';
const ENERGY_MEASURAND = 'Energy.Active.Import.Register';

// Polling cadence for an open transaction. 5 s matches SystemPage's
// REST poll for sys/status — slow enough to be cheap, fast enough that
// an operator watching a session sees movement.
const OPEN_TX_REFETCH_MS = 5_000;

// Cap meter-values per call. The gateway accepts up to 10 000; we
// don't expect anywhere near that for a single session, but a bounded
// limit keeps the chart's data shape predictable.
const METER_VALUES_LIMIT = 5_000;

export function TransactionDetailPage() {
  const { txId: txIdParam } = useParams({ strict: false }) as { txId: string };
  const { token } = useConsoleClient();
  const txId = Number(txIdParam);

  const txQuery = useQuery({
    queryKey: ['transaction', txId],
    queryFn: () => fetchTransaction(token!, txId),
    enabled: !!token && Number.isInteger(txId) && txId > 0,
    refetchInterval: (q) => (q.state.data?.open ? OPEN_TX_REFETCH_MS : false),
  });

  const tx = txQuery.data;
  // Window for the curve queries. For an open tx we anchor 'to' to
  // "now" so each refetch slides the window forward; for a closed tx
  // the window is fixed.
  const now = Date.now();
  const from = tx?.started_at;
  const to = tx?.stopped_at ?? new Date(now).toISOString();

  const enabled = !!token && !!tx && !!from;

  const powerQuery = useQuery({
    queryKey: ['meter-values', tx?.cp_id, txId, POWER_MEASURAND, from, to],
    queryFn: () =>
      fetchMeterValues(token!, tx!.cp_id, {
        from: from!,
        to,
        measurand: POWER_MEASURAND,
        connector_id: tx!.connector_id,
        limit: METER_VALUES_LIMIT,
      }),
    enabled,
    refetchInterval: tx?.open ? OPEN_TX_REFETCH_MS : false,
  });

  const energyQuery = useQuery({
    queryKey: ['meter-values', tx?.cp_id, txId, ENERGY_MEASURAND, from, to],
    queryFn: () =>
      fetchMeterValues(token!, tx!.cp_id, {
        from: from!,
        to,
        measurand: ENERGY_MEASURAND,
        connector_id: tx!.connector_id,
        limit: METER_VALUES_LIMIT,
      }),
    enabled,
    refetchInterval: tx?.open ? OPEN_TX_REFETCH_MS : false,
  });

  // Live-refresh the two curves the moment a MeterValues arrives.
  // Polling stays as a safety net (best-effort Kafka tail), so the
  // 5 s cadence remains the floor; this just makes the common case
  // feel live during an active session. Refetch is no-op while the
  // tx is closed (queryKey changes — `to` becomes the fixed
  // `stopped_at`).
  const meterQueryKeys = useMemo(
    () =>
      tx?.cp_id
        ? [
            ['meter-values', tx.cp_id, txId, POWER_MEASURAND],
            ['meter-values', tx.cp_id, txId, ENERGY_MEASURAND],
            ['transaction', txId],
          ]
        : [],
    [tx?.cp_id, txId],
  );
  useInvalidateOnCpEvents({
    cpId: tx?.cp_id ?? '',
    queryKeys: meterQueryKeys,
    kinds: ['meter', 'tx-stopped'],
  });

  if (!Number.isInteger(txId) || txId <= 0) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Invalid transaction id</AlertTitle>
        <AlertDescription>tx_id must be a positive integer.</AlertDescription>
      </Alert>
    );
  }

  if (txQuery.isLoading || (!txQuery.data && !txQuery.error)) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading transaction…
      </div>
    );
  }

  if (txQuery.error || !tx) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Couldn't load transaction {txId}</AlertTitle>
        <AlertDescription>
          {txQuery.error instanceof Error ? txQuery.error.message : 'unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Header tx={tx} />
      <PowerChart samples={powerQuery.data?.meter_values ?? []} loading={powerQuery.isLoading} />
      <EnergyChart samples={energyQuery.data?.meter_values ?? []} loading={energyQuery.isLoading} />
      <PhasesCard phases={tx.telemetry?.phases ?? null} />
      {tx.telemetry?.soc.last != null ? <SocCard soc={tx.telemetry.soc} /> : null}
      <TxOcppFramesPanel txId={tx.transaction_id} />
    </div>
  );
}

function Header({ tx }: { tx: TransactionDetail }) {
  const kwh = computeKwh(tx);
  const status = tx.open ? 'open' : 'closed';
  return (
    <div className="space-y-2">
      <div>
        <h2 className="font-mono text-lg font-semibold sm:text-xl">tx {tx.transaction_id}</h2>
        <p className="text-sm text-muted-foreground">
          on{' '}
          <Link
            to="/inspect/charge-points/$cpId"
            params={{ cpId: tx.cp_id } as never}
            className="font-mono text-foreground/80 underline-offset-2 hover:underline"
          >
            {tx.cp_id}
          </Link>{' '}
          · connector {tx.connector_id} · id_tag <span className="font-mono">{tx.id_tag}</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tx.open ? 'success' : 'muted'}>{status}</Badge>
        <Badge variant="secondary" className="font-mono text-xs" title={tx.started_at}>
          started: {formatLocalTime(tx.started_at)}
        </Badge>
        <Badge variant="secondary" className="font-mono text-xs" title={tx.stopped_at ?? ''}>
          stopped: {tx.stopped_at ? formatLocalTime(tx.stopped_at) : '—'}
        </Badge>
        <Badge variant="secondary" className="font-mono text-xs">
          duration: {formatDuration(tx)}
        </Badge>
        <Badge variant="secondary" className="font-mono text-xs">
          kWh: {kwh != null ? kwh.toFixed(3) : '—'}
        </Badge>
        {tx.stop_reason ? (
          <Badge variant="secondary" className="font-mono text-xs">
            reason: {tx.stop_reason}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  empty: boolean;
  loading: boolean;
}

function ChartCard({ title, children, empty, loading }: ChartCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : empty ? (
          <p className="text-sm text-muted-foreground">No samples in this window.</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

// Active power per phase + an aggregate sum line. Per-phase samples
// (phase=L1/L2/L3) become individual lines; aggregate samples (phase
// is null — the charger reports total power, no per-phase breakdown)
// become the 'sum' line. We don't synthesize a sum from the per-phase
// samples — chargers' clocks aren't aligned tightly enough for that to
// be meaningful at sub-second resolution.
function PowerChart({ samples, loading }: { samples: MeterValueSample[]; loading: boolean }) {
  const { data, phases, hasSum } = useMemo(() => buildPowerSeries(samples), [samples]);
  const empty = data.length === 0;
  return (
    <ChartCard title="Active power" empty={empty} loading={loading}>
      <ChartContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" tickFormatter={formatTick} minTickGap={48} />
          <YAxis
            tickFormatter={(v: number) => v.toFixed(1)}
            label={{ value: 'kW', position: 'insideLeft', angle: -90, dy: 10, fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(t: number) => new Date(t).toLocaleString()}
            formatter={(v: number) => v.toFixed(2)}
          />
          <Legend />
          {phases.map((phase, idx) => (
            <Line
              key={phase}
              type="monotone"
              dataKey={phase}
              name={phase}
              stroke={LINE_COLOURS[idx % LINE_COLOURS.length]!}
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          {hasSum ? (
            <Line
              type="monotone"
              dataKey="sum"
              name="sum"
              stroke="#1A282F"
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

// Cumulative energy register over time. One series — Energy.Active.
// Import.Register is reported by the charger as a single (typically
// Wh) value per sample. We render it as a step-monotone line because
// it's monotone non-decreasing.
function EnergyChart({ samples, loading }: { samples: MeterValueSample[]; loading: boolean }) {
  const data = useMemo(() => buildEnergySeries(samples), [samples]);
  const empty = data.length === 0;
  return (
    <ChartCard title="Cumulative energy" empty={empty} loading={loading}>
      <ChartContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="t" tickFormatter={formatTick} minTickGap={48} />
          <YAxis
            tickFormatter={(v: number) => v.toFixed(2)}
            label={{ value: 'kWh', position: 'insideLeft', angle: -90, dy: 14, fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(t: number) => new Date(t).toLocaleString()}
            formatter={(v: number) => v.toFixed(3)}
          />
          <Line
            type="monotone"
            dataKey="kwh"
            name="kWh"
            stroke="#F04E1F"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

function PhasesCard({ phases }: { phases: Record<string, PhaseSnapshot> | null }) {
  const entries = phases ? Object.entries(phases) : [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Phases (latest sample)</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No phase telemetry available.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="phases-list">
            {entries.map(([phase, p]) => (
              <li
                key={phase}
                className="grid grid-cols-2 gap-1.5 px-4 py-3 text-xs sm:grid-cols-5"
                data-testid={`phase-row-${phase}`}
              >
                <div className="font-mono font-semibold text-foreground/90">{phase}</div>
                <Field k="V" v={fmtNum(p.voltage_v, 1)} />
                <Field k="A" v={fmtNum(p.current_a, 2)} />
                <Field k="W" v={fmtNum(p.power_w, 0)} />
                <Field k="pf" v={fmtNum(p.power_factor, 2)} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SocCard({
  soc,
}: {
  soc: { start: number | null; last: number | null; delta: number | null };
}) {
  return (
    <Card data-testid="soc-card">
      <CardHeader className="pb-3">
        <CardTitle>State of Charge</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <SocStat k="start" v={soc.start} />
          <SocStat k="last" v={soc.last} />
          <SocStat k="delta" v={soc.delta} signed />
        </dl>
      </CardContent>
    </Card>
  );
}

function SocStat({ k, v, signed }: { k: string; v: number | null; signed?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="font-mono text-base">
        {v == null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%`}
      </dd>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono text-foreground/80">{v}</span>
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

const LINE_COLOURS = ['#F04E1F', '#22C55E', '#3B82F6', '#A855F7'];

interface PowerPoint {
  t: number;
  // Dynamically keyed by phase + 'sum'. Kept loose so Recharts can
  // pick the dataKeys.
  [k: string]: number | undefined;
}

function buildPowerSeries(samples: MeterValueSample[]): {
  data: PowerPoint[];
  phases: string[];
  hasSum: boolean;
} {
  // Group by occurred_at; one row per timestamp with a column per phase
  // (and a 'sum' column for aggregate samples). All values are
  // normalised to kW regardless of the sample's reported unit.
  const byTime = new Map<number, PowerPoint>();
  const phaseSet = new Set<string>();
  let hasSum = false;
  for (const s of samples) {
    const t = new Date(s.occurred_at).getTime();
    if (Number.isNaN(t)) continue;
    const kw = toKilowatts(s.value, s.unit);
    if (kw == null) continue;
    let row = byTime.get(t);
    if (!row) {
      row = { t };
      byTime.set(t, row);
    }
    if (s.phase) {
      phaseSet.add(s.phase);
      row[s.phase] = kw;
    } else {
      hasSum = true;
      row.sum = kw;
    }
  }
  const data = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  // Stable phase order (L1 < L2 < L3 < anything else).
  const phases = Array.from(phaseSet).sort((a, b) => a.localeCompare(b));
  return { data, phases, hasSum };
}

interface EnergyPoint {
  t: number;
  kwh: number;
}

function buildEnergySeries(samples: MeterValueSample[]): EnergyPoint[] {
  const out: EnergyPoint[] = [];
  for (const s of samples) {
    const t = new Date(s.occurred_at).getTime();
    if (Number.isNaN(t)) continue;
    const kwh = toKilowattHours(s.value, s.unit);
    if (kwh == null) continue;
    out.push({ t, kwh });
  }
  return out.sort((a, b) => a.t - b.t);
}

function toKilowatts(v: number, unit: string): number | null {
  switch (unit) {
    case 'W':
      return v / 1000;
    case 'kW':
      return v;
    default:
      return null;
  }
}

function toKilowattHours(v: number, unit: string): number | null {
  switch (unit) {
    case 'Wh':
      return v / 1000;
    case 'kWh':
      return v;
    default:
      return null;
  }
}

function computeKwh(tx: TransactionDetail): number | null {
  if (tx.meter_stop_wh == null) return null;
  return (tx.meter_stop_wh - tx.meter_start_wh) / 1000;
}

function formatDuration(tx: TransactionDetail): string {
  if (tx.open) {
    return formatUptime(tx.started_at);
  }
  if (!tx.stopped_at) return '—';
  const startMs = new Date(tx.started_at).getTime();
  const stopMs = new Date(tx.stopped_at).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(stopMs) || stopMs < startMs) return '—';
  const sec = Math.floor((stopMs - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatTick(t: number): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtNum(v: number | null, digits: number): string {
  if (v == null) return '—';
  return v.toFixed(digits);
}
