// OCPP Log tab on the charger detail page.
//
// Verbatim per-charger frame audit, both directions, backed by the
// gateway's `cp_ocpp_frames` ClickHouse table via the
// /sys/charge-points/:cp_id/frames proxy.
//
// One-shot fetch per filter change (no live tail — that's the
// Events tab's job). Default window 1h to keep the response
// compact; switcher offers 15m / 1h / 6h / 24h. Direction +
// action filters are passthrough to the gateway.
//
// Row layout is dense (timestamp · direction · action · message
// type · message id · transaction_id?) with a click-to-expand
// raw_payload pane so the operator can inspect the JSON without
// every row taking 200px vertical.

import { ChevronDown, ChevronRight, Download, Filter, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { fetchCpFrames, type CpFramesResponse, type OcppFrame } from '@/api/frames-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatAbsoluteTime } from '@/lib/time';
import { useConsoleClient } from '@/lib/ws-context';
import { cn } from '@/lib/utils';

type RangeMinutes = 15 | 60 | 360 | 1440;
const RANGE_OPTIONS: ReadonlyArray<{ minutes: RangeMinutes; label: string }> = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
];

type DirectionFilter = 'all' | 'inbound' | 'outbound';

export interface OcppLogPanelProps {
  cpId: string;
}

export function OcppLogPanel({ cpId }: OcppLogPanelProps) {
  const { token } = useConsoleClient();
  const [rangeMinutes, setRangeMinutes] = useState<RangeMinutes>(60);
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [actionFilter, setActionFilter] = useState('');
  const [nonce, setNonce] = useState(0); // bump to force a refetch
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'ok'; data: CpFramesResponse }
    | { phase: 'error'; detail: string }
  >({ phase: 'loading' });

  const window = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - rangeMinutes * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [rangeMinutes]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setState({ phase: 'loading' });
    const params: Parameters<typeof fetchCpFrames>[2] = {
      from: window.from,
      to: window.to,
      limit: 500,
    };
    if (direction !== 'all') params.direction = direction;
    const trimmedAction = actionFilter.trim();
    if (trimmedAction) params.action = trimmedAction;
    fetchCpFrames(token, cpId, params)
      .then((data) => {
        if (!cancelled) setState({ phase: 'ok', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: 'error',
          detail: err instanceof Error ? err.message : 'request failed',
        });
      });
    return () => {
      cancelled = true;
    };
    // actionFilter is intentionally committed here on each render to
    // keep the wiring simple — the input is debounced below by only
    // refetching on blur/Enter, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpId, token, window, direction, nonce]);

  return (
    <Card data-testid="ocpp-log-panel">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">OCPP Log</CardTitle>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                state.phase === 'ok' && downloadFramesCsv(cpId, state.data.frames, rangeMinutes)
              }
              disabled={state.phase !== 'ok' || state.data.frames.length === 0}
              aria-label="Export OCPP log as CSV"
              data-testid="ocpp-log-export"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNonce((n) => n + 1)}
              aria-label="Refresh OCPP log"
              data-testid="ocpp-log-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <FilterRow
          rangeMinutes={rangeMinutes}
          onRangeChange={setRangeMinutes}
          direction={direction}
          onDirectionChange={setDirection}
          actionFilter={actionFilter}
          onActionFilterChange={setActionFilter}
          onCommitActionFilter={() => setNonce((n) => n + 1)}
        />
      </CardHeader>
      <CardContent className="pt-0">
        {state.phase === 'loading' ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading frames…
          </div>
        ) : state.phase === 'error' ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            Couldn&apos;t load frames: {state.detail}
          </div>
        ) : state.data.frames.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No OCPP frames in this window. Widen the range or clear the filters.
          </p>
        ) : (
          <ul className="divide-y" data-testid="ocpp-log-rows">
            {state.data.frames.map((f) => (
              <FrameRow key={f.event_id} frame={f} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FilterRow({
  rangeMinutes,
  onRangeChange,
  direction,
  onDirectionChange,
  actionFilter,
  onActionFilterChange,
  onCommitActionFilter,
}: {
  rangeMinutes: RangeMinutes;
  onRangeChange: (v: RangeMinutes) => void;
  direction: DirectionFilter;
  onDirectionChange: (v: DirectionFilter) => void;
  actionFilter: string;
  onActionFilterChange: (v: string) => void;
  onCommitActionFilter: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="inline-flex rounded-md border bg-background p-0.5">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.minutes}
            type="button"
            onClick={() => onRangeChange(opt.minutes)}
            className={cn(
              'rounded-sm px-2 py-0.5',
              opt.minutes === rangeMinutes
                ? 'bg-foreground text-background'
                : 'text-muted-foreground',
            )}
            data-testid={`ocpp-log-range-${opt.minutes}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <Select
        value={direction}
        onChange={(e) => onDirectionChange(e.currentTarget.value as DirectionFilter)}
        className="h-8 w-[130px]"
        aria-label="Direction"
        data-testid="ocpp-log-direction"
      >
        <option value="all">All directions</option>
        <option value="inbound">Inbound (CP→GW)</option>
        <option value="outbound">Outbound (GW→CP)</option>
      </Select>
      <div className="relative">
        <Filter className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={actionFilter}
          onChange={(e) => onActionFilterChange(e.currentTarget.value)}
          onBlur={onCommitActionFilter}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitActionFilter();
            }
          }}
          placeholder="action (BootNotification, MeterValues, …)"
          className="h-8 w-[260px] pl-7 font-mono text-xs"
          data-testid="ocpp-log-action-input"
        />
      </div>
    </div>
  );
}

function FrameRow({ frame }: { frame: OcppFrame }) {
  const [open, setOpen] = useState(false);
  const dirChip = (
    <Badge
      variant="secondary"
      className={cn(
        'shrink-0 font-mono text-[10px]',
        frame.direction === 'inbound'
          ? 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200'
          : 'bg-purple-100 text-purple-900 dark:bg-purple-950 dark:text-purple-200',
      )}
    >
      {frame.direction === 'inbound' ? 'in' : 'out'}
    </Badge>
  );
  const typeLabel = ocppTypeLabel(frame.message_type);
  const pretty = useMemo(() => prettyJson(frame.raw_payload), [frame.raw_payload]);
  return (
    <li className="py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left font-mono text-[11px] hover:bg-muted/50"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span
          className="shrink-0 text-muted-foreground"
          title={formatAbsoluteTime(frame.occurred_at)}
        >
          {shortTime(frame.occurred_at)}
        </span>
        {dirChip}
        <span className="shrink-0 text-muted-foreground">{typeLabel}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {frame.action || '—'}
        </span>
        {frame.transaction_id != null ? (
          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
            tx {frame.transaction_id}
          </Badge>
        ) : null}
        <span className="shrink-0 truncate text-[10px] text-muted-foreground">
          {frame.message_id}
        </span>
      </button>
      {open ? (
        <pre className="ml-5 mt-1 overflow-x-auto rounded border bg-muted/30 p-2 text-[10px] leading-snug">
          {pretty}
        </pre>
      ) : null}
    </li>
  );
}

function ocppTypeLabel(t: number): string {
  switch (t) {
    case 2:
      return 'CALL';
    case 3:
      return 'RESULT';
    case 4:
      return 'ERROR';
    default:
      return `?${t}`;
  }
}

function shortTime(iso: string): string {
  // Frame timestamps arrive as UTC ISO strings. Render in the operator's
  // browser zone so a UK operator watching a Turkish site sees times that
  // match their wall clock. `title` on the caller carries the full
  // absolute time + offset for exact correlation with backend logs.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prettyJson(raw: string): string {
  // The raw_payload is OCPP-J: [msgType, msgId, action?, payload].
  // Try to pretty-print; fall back to the verbatim string if it's
  // not valid JSON (would be a gateway bug, but don't crash on it).
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function downloadFramesCsv(cpId: string, frames: readonly OcppFrame[], rangeMinutes: number) {
  // Two timestamps per row: UTC (matches backend logs, unambiguous for
  // on-call handoff) and browser-local (matches what the operator saw
  // on screen). Raw payload is CSV-escaped so multi-line JSON survives
  // Excel round-trips.
  const header = [
    'occurred_at_utc',
    'occurred_at_local',
    'direction',
    'ocpp_type',
    'action',
    'message_id',
    'transaction_id',
    'raw_payload',
  ];
  const rows = frames.map((f) => [
    f.occurred_at,
    formatAbsoluteTime(f.occurred_at),
    f.direction,
    ocppTypeLabel(f.message_type),
    f.action ?? '',
    f.message_id,
    f.transaction_id != null ? String(f.transaction_id) : '',
    f.raw_payload,
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ocpp-log-${cpId}-${rangeMinutes}m-${csvFilenameStamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v: string): string {
  // RFC 4180: wrap in quotes when the cell has a comma, quote, or
  // newline; escape internal quotes by doubling. Every cell that
  // could contain a quote or comma gets wrapped; short ints and
  // action names skip the wrap for readability.
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function csvFilenameStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
