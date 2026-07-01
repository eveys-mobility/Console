// OCPP frames panel for the transaction detail page. Verbatim
// per-transaction frame audit, both directions, backed by the
// gateway's `cp_ocpp_frames` ClickHouse table via the
// /sys/transactions/:tx_id/frames proxy.
//
// Simpler than the per-charger OcppLogPanel: no time window (the
// transaction itself bounds the result) and no direction filter (the
// volume per tx is bounded; the operator wants every frame).
//
// Auto-refresh for open transactions: TanStack Query polls every
// 5 s while `isOpen`, and `useInvalidateOnCpEvents` pushes a refetch
// the moment a device event arrives on the same cp_id (every OCPP
// action a charger sends produces a stored frame, so any kind of
// event is a signal that a new frame exists). Closed transactions
// stay one-shot; the manual refresh button remains for both.

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { fetchTxFrames, type OcppFrame } from '@/api/frames-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useInvalidateOnCpEvents } from '@/hooks/use-invalidate-on-cp-events';
import { formatAbsoluteTime } from '@/lib/time';
import { useConsoleClient } from '@/lib/ws-context';
import { cn } from '@/lib/utils';

const DEFAULT_LIMIT = 1_000;
const OPEN_TX_REFETCH_MS = 5_000;

export interface TxOcppFramesPanelProps {
  txId: number;
  /** cp_id of the transaction. When set together with `isOpen`, the
   *  panel push-refreshes the frame list on every device event that
   *  arrives for this charger. Optional so consumers that only know
   *  the txId (e.g. tests) still work. */
  cpId?: string;
  /** True while the transaction is open. Enables the 5 s poll and the
   *  push-refresh path. */
  isOpen?: boolean;
}

export function TxOcppFramesPanel({ txId, cpId, isOpen }: TxOcppFramesPanelProps) {
  const { token } = useConsoleClient();
  const query = useQuery({
    queryKey: ['tx-ocpp-frames', txId],
    queryFn: () => fetchTxFrames(token!, txId, { limit: DEFAULT_LIMIT }),
    enabled: !!token,
    refetchInterval: isOpen ? OPEN_TX_REFETCH_MS : false,
  });

  const invalidateKeys = useMemo(
    () => (cpId && isOpen ? [['tx-ocpp-frames', txId]] : []),
    [cpId, isOpen, txId],
  );
  useInvalidateOnCpEvents({
    cpId: cpId ?? '',
    queryKeys: invalidateKeys,
  });

  const frames = query.data?.frames ?? [];
  return (
    <Card data-testid="tx-ocpp-frames-panel">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">OCPP frames</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          aria-label="Refresh OCPP frames"
          data-testid="tx-ocpp-frames-refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {query.isPending ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading frames…
          </div>
        ) : query.error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            Couldn&apos;t load frames:{' '}
            {query.error instanceof Error ? query.error.message : 'request failed'}
          </div>
        ) : frames.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No OCPP frames recorded for this transaction yet.
          </p>
        ) : (
          <ul className="divide-y" data-testid="tx-ocpp-frames-rows">
            {frames.map((f) => (
              <FrameRow key={f.event_id} frame={f} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
        data-testid={`tx-frame-row-${frame.event_id}`}
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

// HH:mm:ss in the operator's local timezone. A single tx is bounded
// so same-day disambig isn't needed inside one session; the hover
// title carries the full local timestamp + zone offset for anyone
// correlating with UTC-stored logs.
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
