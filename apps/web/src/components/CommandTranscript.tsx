// Live transcript pane for the Commands console. Shows each command
// the operator sent and the charger's actual response — replaces the
// "Command accepted by charger" toast with the real outcome inline.
//
// Per row:
//   - timestamp (HH:MM:SS) + monotonic id
//   - method name + ms elapsed + status pill (Accepted / Rejected /
//     Occupied etc) coloured by outcome bucket
//   - request and response JSON, each behind a toggle so the row
//     stays compact until inspected
//
// Controls:
//   - Pause / Resume — pending completions buffer; a +N pill on the
//     Resume button shows how many missed.
//   - Clear — wipes the visible list.
//   - Filter — All / Failed / Accepted; AND with the method filter.
//
// Empty state explains what the panel shows so a first-time operator
// doesn't see an empty pane and assume the page is broken.

import { Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  TranscriptEntry,
  TranscriptOutcome,
  UseCommandTranscript,
} from '@/hooks/use-command-transcript';
import { cn } from '@/lib/utils';

const OUTCOME_LABEL: Record<TranscriptOutcome, string> = {
  accepted: 'accepted',
  rejected: 'rejected',
  'soft-reject': 'soft-reject',
  pending: 'sending…',
  error: 'transport error',
  unknown: 'result unknown',
};

const OUTCOME_VARIANT: Record<
  TranscriptOutcome,
  'success' | 'destructive' | 'warning' | 'muted' | 'secondary'
> = {
  accepted: 'success',
  rejected: 'destructive',
  'soft-reject': 'warning',
  pending: 'muted',
  error: 'destructive',
  unknown: 'warning',
};

type Filter = 'all' | 'failed' | 'accepted';

export function CommandTranscript({ t }: { t: UseCommandTranscript }) {
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    if (filter === 'all') return t.entries;
    if (filter === 'accepted') return t.entries.filter((e) => e.outcome === 'accepted');
    return t.entries.filter((e) => e.outcome !== 'accepted' && e.outcome !== 'pending');
  }, [t.entries, filter]);

  return (
    <Card data-testid="command-transcript" className="flex h-full flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Command transcript
            <span
              className="ml-2 font-mono text-xs text-muted-foreground"
              data-testid="transcript-count"
            >
              {visible.length}
              {visible.length !== t.entries.length ? `/${t.entries.length}` : ''}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {t.paused ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={t.resume}
                data-testid="transcript-resume"
              >
                <Play className="h-3.5 w-3.5" /> Resume
                {t.bufferedCount > 0 ? (
                  <Badge variant="muted" className="ml-1 text-[10px]">
                    +{t.bufferedCount}
                  </Badge>
                ) : null}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={t.pause}
                data-testid="transcript-pause"
              >
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={t.clear}
              data-testid="transcript-clear"
              disabled={t.entries.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          </div>
        </div>
        <FilterChips value={filter} onChange={setFilter} />
      </CardHeader>

      <CardContent className="flex flex-1 flex-col overflow-hidden p-3 pt-0">
        {t.entries.length === 0 ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="transcript-no-match">
            No commands match the current filter.
          </p>
        ) : (
          <ul className="space-y-2 overflow-y-auto pr-1" data-testid="transcript-list">
            {visible.map((entry) => (
              <TranscriptRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      data-testid="transcript-empty"
    >
      <p className="mb-1 font-medium text-foreground">Nothing sent yet.</p>
      <p>
        Click a Send button on a command card. The request the gateway forwarded and the charger's
        response will land here with timing and a status pill.
      </p>
    </div>
  );
}

function FilterChips({ value, onChange }: { value: Filter; onChange: (next: Filter) => void }) {
  const opts: Array<{ k: Filter; label: string }> = [
    { k: 'all', label: 'All' },
    { k: 'accepted', label: 'Accepted only' },
    { k: 'failed', label: 'Failed only' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {opts.map((o) => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          aria-pressed={value === o.k}
          data-testid={`transcript-filter-${o.k}`}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
            value === o.k
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background text-muted-foreground hover:bg-accent',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const [reqOpen, setReqOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);

  const time = entry.startedAt.slice(11, 19); // HH:MM:SS from the ISO string
  const variant = OUTCOME_VARIANT[entry.outcome];
  const label =
    entry.phase === 'pending'
      ? OUTCOME_LABEL.pending
      : entry.phase === 'error'
        ? (entry.status ?? 'transport error')
        : (entry.status ?? OUTCOME_LABEL[entry.outcome]);

  return (
    <li
      className="space-y-1 rounded-md border bg-card/50 p-2 text-xs"
      data-testid="transcript-row"
      data-method={entry.method}
      data-outcome={entry.outcome}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-muted-foreground" title={entry.startedAt}>
          {time}
        </span>
        <span className="font-medium">{entry.method}</span>
        {entry.phase === 'pending' ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="sending" />
        ) : null}
        <Badge variant={variant} className="text-[10px]">
          {label}
        </Badge>
        {typeof entry.elapsedMs === 'number' ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {entry.elapsedMs} ms
          </span>
        ) : null}
      </div>

      <ResponseHighlights entry={entry} />

      <div className="flex flex-wrap gap-2">
        <RowToggle
          label={reqOpen ? '← Hide request' : '→ Show request'}
          testId="transcript-toggle-req"
          onClick={() => setReqOpen((v) => !v)}
        />
        {entry.phase !== 'pending' ? (
          <RowToggle
            label={resOpen ? '← Hide response' : '→ Show response'}
            testId="transcript-toggle-res"
            onClick={() => setResOpen((v) => !v)}
          />
        ) : null}
      </div>

      {reqOpen ? (
        <JsonBlock label="→ REQ" value={entry.request} testId="transcript-req-json" />
      ) : null}
      {resOpen && entry.phase !== 'pending' ? (
        <JsonBlock
          label="← RESP"
          value={entry.phase === 'error' ? { error: entry.error } : entry.response}
          testId="transcript-res-json"
        />
      ) : null}
    </li>
  );
}

function RowToggle({
  label,
  testId,
  onClick,
}: {
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[10px] uppercase tracking-wider text-muted-foreground underline-offset-2 hover:underline"
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/** Surfaces a couple of fields from the OCPP response inline next to
 *  the row's status pill so the operator doesn't have to expand the
 *  JSON toggle for the most common follow-up actions. Today that's
 *  `reservation_id` on a successful ReserveNow — without it the
 *  operator has no way to know what id to pass to CancelReservation
 *  short of reading the JSON. Extend cautiously: anything added here
 *  has to be obvious and short, otherwise it bloats the row. */
function ResponseHighlights({ entry }: { entry: TranscriptEntry }) {
  if (entry.phase !== 'ok' || entry.outcome !== 'accepted') return null;
  if (!entry.response || typeof entry.response !== 'object') return null;
  const res = entry.response as Record<string, unknown>;
  const chips: { label: string; value: string }[] = [];
  if (entry.method === 'reserve-now' && typeof res.reservation_id === 'number') {
    chips.push({ label: 'reservation_id', value: String(res.reservation_id) });
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="transcript-response-highlights">
      {chips.map((c) => (
        <span
          key={c.label}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10px]"
        >
          <span className="text-muted-foreground">{c.label}</span>
          <span className="font-semibold text-foreground">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

function JsonBlock({ label, value, testId }: { label: string; value: unknown; testId: string }) {
  return (
    <div className="space-y-0.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <pre
        className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px] text-foreground/90"
        data-testid={testId}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
