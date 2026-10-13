// Live event feed for a single charger. Subscribes to `device-events`
// for the given cp_id and prepends each delta to an in-memory ring
// (cap 500, oldest dropped). The subscription snapshot bootstraps
// the ring with up to 200 recent events from the durable on-disk
// log, so the panel renders history immediately on first open.
//
// Search beyond the live ring (older months, anything older than the
// snapshot) goes through `/sys/charge-points/:cp_id/events` — the
// server-side scan of the NDJSON log files.
//
// Controls:
//   - Pause / Resume — buffers events while paused so resuming
//     replays the missed window (no event loss, but the ring still
//     applies once they're flushed in).
//   - Clear — wipes the visible list without unsubscribing.
//   - Kind chips — toggles per-kind visibility. AND with the search.
//   - Search — case-insensitive substring over summary + detail
//     values. Searches the in-memory ring first; "Search history"
//     hits the server for matches outside the ring.
//   - View mode (Pretty | JSON | Compact) — global render shape;
//     persisted in localStorage so the operator's preference sticks.
//   - Load older — fetches an older page from the server.

import { Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DeviceEvent } from '@eveys-console/protocol';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSubscription } from '@/hooks/use-subscription';
import { formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useConsoleClient } from '@/lib/ws-context';

const RING_CAP = 500;
const VIEW_MODE_KEY = 'eveys-console.device-events.view-mode';

type ViewMode = 'pretty' | 'json' | 'compact';
const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'pretty', label: 'Pretty' },
  { value: 'json', label: 'JSON' },
  { value: 'compact', label: 'Compact' },
];

function loadViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'pretty';
  const v = window.localStorage.getItem(VIEW_MODE_KEY);
  return v === 'json' || v === 'compact' ? v : 'pretty';
}

type ChipVariant = 'success' | 'warning' | 'secondary' | 'default';

const KIND_META: Record<DeviceEvent['kind'], { variant: ChipVariant; label: string }> = {
  boot: { variant: 'success', label: 'boot' },
  status: { variant: 'warning', label: 'status' },
  meter: { variant: 'secondary', label: 'meter' },
  'tx-started': { variant: 'default', label: 'tx-started' },
  'tx-stopped': { variant: 'secondary', label: 'tx-stopped' },
  connected: { variant: 'success', label: 'connected' },
  disconnected: { variant: 'warning', label: 'disconnected' },
  'diagnostics-status': { variant: 'default', label: 'diagnostics' },
  'firmware-status': { variant: 'default', label: 'firmware' },
};
const ALL_KINDS = Object.keys(KIND_META) as DeviceEvent['kind'][];

export interface DeviceEventsPanelProps {
  cpId: string;
}

export function DeviceEventsPanel({ cpId }: DeviceEventsPanelProps) {
  const sub = useSubscription('device-events', { cp_id: cpId });
  const { token } = useConsoleClient();
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const pauseBufferRef = useRef<DeviceEvent[]>([]);
  const lastSeenDeltaRef = useRef<DeviceEvent | null>(null);
  const lastSeenSnapshotRef = useRef<unknown>(null);
  const [enabledKinds, setEnabledKinds] = useState<Set<DeviceEvent['kind']>>(
    () => new Set(ALL_KINDS),
  );
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  // Reset on cp_id change.
  useEffect(() => {
    setEvents([]);
    pauseBufferRef.current = [];
    lastSeenDeltaRef.current = null;
    lastSeenSnapshotRef.current = null;
    setOlderCursor(null);
    setOlderError(null);
  }, [cpId]);

  // Bootstrap from the subscription snapshot. The server populates
  // it from the durable log so the panel shows recent history
  // immediately rather than waiting for the next live event.
  useEffect(() => {
    const snap = sub.snapshot as { kind: string; rows?: DeviceEvent[] } | null;
    if (!snap || snap.kind !== 'device-events') return;
    if (lastSeenSnapshotRef.current === snap) return;
    lastSeenSnapshotRef.current = snap;
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    if (rows.length === 0) return;
    // Snapshot is newest-first; the ring is newest-first too.
    setEvents((prev) => {
      // Merge without duplicating events that the live stream
      // delivered before the snapshot arrived.
      const seen = new Set(prev.map((e) => e.at + '|' + e.summary));
      const merged = [...prev];
      for (const row of rows) {
        const key = row.at + '|' + row.summary;
        if (!seen.has(key)) {
          merged.push(row);
          seen.add(key);
        }
      }
      merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return merged.slice(0, RING_CAP);
    });
  }, [sub.snapshot]);

  useEffect(() => {
    const delta = sub.lastDelta;
    if (!delta || delta.kind !== 'device-events') return;
    if (lastSeenDeltaRef.current === delta.append) return;
    lastSeenDeltaRef.current = delta.append;
    if (paused) {
      const buf = pauseBufferRef.current;
      buf.unshift(delta.append);
      if (buf.length > RING_CAP) buf.length = RING_CAP;
      return;
    }
    setEvents((prev) => {
      const next = [delta.append, ...prev];
      return next.length > RING_CAP ? next.slice(0, RING_CAP) : next;
    });
  }, [sub.lastDelta, paused]);

  // Persist the view-mode preference.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  // Fetch an older page from the durable log starting before the
  // oldest event currently in the ring.
  const loadOlder = useCallback(async () => {
    if (!token || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const oldest = events[events.length - 1];
      const params: { to?: string; cursor?: string; limit: number } = { limit: 100 };
      if (olderCursor) params.cursor = olderCursor;
      else if (oldest) params.to = oldest.at;
      // 1 year window upper bound — matches the retention default.
      const { fetchCpEvents } = await import('@/api/events-client');
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const page = await fetchCpEvents(token, cpId, {
        from: yearAgo,
        ...params,
      });
      if (page.events.length === 0) {
        setOlderError('No earlier events.');
        return;
      }
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.at + '|' + e.summary));
        const merged = [...prev];
        for (const row of page.events) {
          const key = row.at + '|' + row.summary;
          if (!seen.has(key)) {
            merged.push(row);
            seen.add(key);
          }
        }
        merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        // Loading older shouldn't be trimmed by the ring cap.
        return merged;
      });
      setOlderCursor(page.next_cursor);
    } catch (err) {
      setOlderError(err instanceof Error ? err.message : 'unknown');
    } finally {
      setLoadingOlder(false);
    }
  }, [token, cpId, events, olderCursor, loadingOlder]);

  const onResume = () => {
    // Flush whatever buffered up while paused, then resume live append.
    const buffered = pauseBufferRef.current;
    pauseBufferRef.current = [];
    setPaused(false);
    if (buffered.length > 0) {
      setEvents((prev) => {
        const next = [...buffered, ...prev];
        return next.length > RING_CAP ? next.slice(0, RING_CAP) : next;
      });
    }
  };

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return events.filter((ev) => {
      if (!enabledKinds.has(ev.kind)) return false;
      if (!term) return true;
      if (ev.summary.toLowerCase().includes(term)) return true;
      if (ev.detail) {
        for (const v of Object.values(ev.detail)) {
          if (v !== null && String(v).toLowerCase().includes(term)) return true;
        }
      }
      return false;
    });
  }, [events, enabledKinds, search]);

  const toggleKind = (k: DeviceEvent['kind']) =>
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const historyState =
    sub.snapshot?.kind === 'device-events' ? sub.snapshot.history_state : undefined;
  const bufferedCount = pauseBufferRef.current.length;

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Live events
            <span
              className="ml-2 font-mono text-xs text-muted-foreground"
              data-testid="device-events-count"
            >
              {visible.length}
              {visible.length !== events.length ? `/${events.length}` : ''}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {paused ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={onResume}
                data-testid="device-events-resume"
              >
                <Play className="h-3.5 w-3.5" /> Resume
                {bufferedCount > 0 ? (
                  <Badge variant="muted" className="ml-1 text-[10px]">
                    +{bufferedCount}
                  </Badge>
                ) : null}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setPaused(true)}
                data-testid="device-events-pause"
              >
                <Pause className="h-3.5 w-3.5" /> Pause
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setEvents([])}
              data-testid="device-events-clear"
              disabled={events.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {ALL_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              data-testid={`device-events-kind-${k}`}
              aria-pressed={enabledKinds.has(k)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
                enabledKinds.has(k)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-accent',
              )}
            >
              {KIND_META[k].label}
            </button>
          ))}
          <div
            className="ml-auto flex items-center gap-2"
            role="group"
            aria-label="Event view mode"
          >
            <div className="flex overflow-hidden rounded-md border">
              {VIEW_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setViewMode(m.value)}
                  aria-pressed={viewMode === m.value}
                  data-testid={`device-events-view-${m.value}`}
                  className={cn(
                    'px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
                    viewMode === m.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="search events…"
              className="h-7 w-[200px] text-xs"
              data-testid="device-events-search"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {sub.error && (
          <p className="mb-3 text-sm text-destructive" role="alert">
            Couldn't subscribe: {sub.error}
            {events.length > 0 ? ' Showing last known events.' : ''}
          </p>
        )}
        {historyState === 'unavailable' && (
          <p className="mb-3 text-sm text-destructive" role="alert">
            Event history unavailable. Live events may still arrive; the local archive could not be
            read.
          </p>
        )}
        {historyState === 'unconfigured' && (
          <p className="mb-3 text-sm text-muted-foreground">
            Event history is not configured. Showing live events only.
          </p>
        )}
        {events.length === 0 ? (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="device-events-empty"
          >
            {sub.loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
              </>
            ) : historyState === 'available' ? (
              'No recorded events in the loaded history. Waiting for live events…'
            ) : (
              'Waiting for events…'
            )}
          </div>
        ) : visible.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="device-events-no-match">
            No events match the current filter.
          </p>
        ) : (
          <>
            <ul className="divide-y" data-testid="device-events-list">
              {visible.map((ev, idx) => (
                <DeviceEventRow key={`${ev.at}-${idx}`} event={ev} viewMode={viewMode} />
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-2 text-xs">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => {
                  void loadOlder();
                }}
                disabled={loadingOlder || !token}
                data-testid="device-events-load-older"
              >
                {loadingOlder ? 'Loading…' : 'Load older'}
              </Button>
              {olderError ? (
                <span className="text-muted-foreground" data-testid="device-events-load-older-msg">
                  {olderError}
                </span>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceEventRow({ event, viewMode }: { event: DeviceEvent; viewMode: ViewMode }) {
  const meta = KIND_META[event.kind];
  const detailEntries = event.detail ? Object.entries(event.detail) : [];
  const hasDetail = detailEntries.length > 0;
  // Per-row toggle still works in Pretty mode for operators who want
  // detail on one row without globally switching. JSON / Compact
  // modes ignore the toggle.
  const [prettyMode, setPrettyMode] = useState<'closed' | 'block' | 'json'>('closed');

  if (viewMode === 'json') {
    return (
      <li className="py-2" data-testid="device-events-row">
        <pre
          className="overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px]"
          data-testid="device-events-json"
        >
          {JSON.stringify(event, null, 2)}
        </pre>
      </li>
    );
  }

  if (viewMode === 'compact') {
    return (
      <li
        className="flex flex-wrap items-center gap-2 py-1 font-mono text-xs"
        data-testid="device-events-row"
      >
        <span className="tabular-nums text-muted-foreground" title={event.at}>
          {event.at.replace('T', ' ').replace('Z', '')}
        </span>
        <span className="text-foreground/80" data-testid="device-events-chip">
          [{meta.label}]
        </span>
        <span data-testid="device-events-summary">{event.summary}</span>
      </li>
    );
  }

  return (
    <li className="space-y-1 py-2" data-testid="device-events-row">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant} data-testid="device-events-chip">
          {meta.label}
        </Badge>
        <span className="font-medium" data-testid="device-events-summary">
          {event.summary}
        </span>
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={event.at}
          data-testid="device-events-time"
        >
          {formatRelativeTime(event.at)}
        </span>
      </div>
      {hasDetail ? (
        <div className="space-x-2">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setPrettyMode(prettyMode === 'block' ? 'closed' : 'block')}
            aria-pressed={prettyMode === 'block'}
            data-testid="device-events-toggle"
          >
            {prettyMode === 'block' ? 'Hide detail' : 'Show detail'}
          </button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setPrettyMode(prettyMode === 'json' ? 'closed' : 'json')}
            aria-pressed={prettyMode === 'json'}
            data-testid="device-events-toggle-json"
          >
            {prettyMode === 'json' ? 'Hide JSON' : 'Show JSON'}
          </button>
          {prettyMode === 'block' ? (
            <dl
              className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs"
              data-testid="device-events-detail"
            >
              {detailEntries.map(([k, v]) => (
                <DetailRow key={k} k={k} v={v} />
              ))}
            </dl>
          ) : null}
          {prettyMode === 'json' ? (
            <pre
              className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px]"
              data-testid="device-events-json"
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DetailRow({ k, v }: { k: string; v: string | number | boolean | null }) {
  return (
    <>
      <dt className="font-mono text-muted-foreground">{k}</dt>
      <dd className="font-mono text-foreground/80">{v === null ? '—' : String(v)}</dd>
    </>
  );
}
