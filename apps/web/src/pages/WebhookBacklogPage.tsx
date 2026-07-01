// Operator surface for the webhook delivery backlog (E3-9 tail).
//
// Two audiences:
//   * "Is the backend catching back up?" — the Live tab shows rows the
//     drainer is still retrying, and refreshes every 10 s.
//   * "Recover from a dead-letter" — the Dead tab shows rows that aged
//     past the retention window. Only 2xx counts as delivered; every
//     other response (including 4xx) is retried until retention hits.
//     Replay re-arms a dead row for immediate delivery; Purge deletes it.
//
// Bulk "Replay all dead" is the post-outage cleanup path — when the
// backend has been down for a stretch, N rows are dead and clicking
// per-row Replay would be tedious.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Radio, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  listWebhookBacklog,
  purgeWebhookBacklog,
  replayDeadWebhookBacklog,
  replayWebhookBacklog,
  type WebhookBacklogRow,
} from '@/api/webhook-backlog-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConsoleClient } from '@/lib/ws-context';

// Cadences: dead rows sit static so the poll is only useful to catch new
// arrivals or a bulk replay that moved rows out of dead. Live rows change
// on every drainer cycle (default 30 s) so 10 s is a comfortable spot.
const LIVE_REFRESH_MS = 10_000;
const DEAD_REFRESH_MS = 20_000;

type TabValue = 'live' | 'dead';

interface CountsQueryResult {
  dead: number;
  live: number;
}

function useBacklogCounts(token: string | null | undefined): CountsQueryResult {
  // Independent gauges, one query per side. Small (1 row each with limit=1)
  // so a table with 100 dead rows still shows the counts fast.
  const deadQ = useQuery({
    queryKey: ['webhook-backlog', 'count', 'dead'],
    queryFn: () => listWebhookBacklog(token!, { dead: true, limit: 500 }),
    enabled: !!token,
    refetchInterval: DEAD_REFRESH_MS,
  });
  const liveQ = useQuery({
    queryKey: ['webhook-backlog', 'count', 'live'],
    queryFn: () => listWebhookBacklog(token!, { dead: false, limit: 500 }),
    enabled: !!token,
    refetchInterval: LIVE_REFRESH_MS,
  });
  return {
    dead: deadQ.data?.rows.length ?? 0,
    live: liveQ.data?.rows.length ?? 0,
  };
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(s: string | null, n = 14): string {
  if (!s) return '—';
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function BacklogRowActions({
  row,
  busy,
  onReplay,
  onPurge,
}: {
  row: WebhookBacklogRow;
  busy: boolean;
  onReplay: () => void;
  onPurge: () => void;
}) {
  if (!row.dead) {
    return <span className="text-xs text-muted-foreground">retrying…</span>;
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={onReplay}>
        <Radio className="mr-1 h-3.5 w-3.5" /> Replay
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onClick={onPurge}>
        <Trash2 className="mr-1 h-3.5 w-3.5" /> Purge
      </Button>
    </div>
  );
}

function BacklogTable({
  rows,
  isLoading,
  emptyHint,
  busyIds,
  onReplay,
  onPurge,
}: {
  rows: WebhookBacklogRow[];
  isLoading: boolean;
  emptyHint: string;
  busyIds: Set<string>;
  onReplay: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead>Attempts</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Next attempt</TableHead>
          <TableHead>Last error</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <TableRow>
            <TableCell colSpan={6} className="text-sm text-muted-foreground">
              Loading…
            </TableCell>
          </TableRow>
        ) : rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-sm text-muted-foreground">
              {emptyHint}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id} data-testid={`backlog-row-${row.id}`}>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-mono text-sm">{row.event_type}</span>
                  <span
                    className="font-mono text-[10px] text-muted-foreground"
                    title={row.event_id}
                  >
                    {truncate(row.event_id, 8)}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-sm">{row.attempts}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatTime(row.created_at)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatTime(row.next_attempt_at)}
              </TableCell>
              <TableCell
                className="max-w-xs truncate text-xs text-muted-foreground"
                title={row.last_error ?? ''}
              >
                {row.last_error ?? '—'}
              </TableCell>
              <TableCell className="text-right">
                <BacklogRowActions
                  row={row}
                  busy={busyIds.has(row.id)}
                  onReplay={() => onReplay(row.id)}
                  onPurge={() => onPurge(row.id)}
                />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export function WebhookBacklogPage() {
  const { token } = useConsoleClient();
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabValue>('dead');

  const listQuery = useQuery({
    queryKey: ['webhook-backlog', 'list', tab],
    queryFn: () =>
      listWebhookBacklog(token!, {
        dead: tab === 'dead',
        limit: 200,
      }),
    enabled: !!token,
    refetchInterval: tab === 'dead' ? DEAD_REFRESH_MS : LIVE_REFRESH_MS,
  });

  const counts = useBacklogCounts(token);
  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['webhook-backlog', 'list'] }),
      qc.invalidateQueries({ queryKey: ['webhook-backlog', 'count'] }),
    ]);

  const busyIds = useMemo(() => new Set<string>(), []);

  const replay = useMutation({
    mutationFn: (id: string) => {
      busyIds.add(id);
      return replayWebhookBacklog(token!, id);
    },
    onSettled: (_data, _err, id) => {
      busyIds.delete(id);
      return invalidate();
    },
  });
  const purge = useMutation({
    mutationFn: (id: string) => {
      busyIds.add(id);
      return purgeWebhookBacklog(token!, id);
    },
    onSettled: (_data, _err, id) => {
      busyIds.delete(id);
      return invalidate();
    },
  });
  const bulkReplay = useMutation({
    mutationFn: () => replayDeadWebhookBacklog(token!),
    onSettled: () => invalidate(),
  });

  const handleReplay = (id: string) => {
    if (window.confirm('Re-arm this row for immediate delivery?')) {
      replay.mutate(id);
    }
  };
  const handlePurge = (id: string) => {
    if (
      window.confirm('Permanently delete this dead-letter row? The original event will be lost.')
    ) {
      purge.mutate(id);
    }
  };
  const handleBulkReplay = () => {
    if (
      counts.dead > 0 &&
      window.confirm(`Re-arm all ${counts.dead} dead-letter row(s) for immediate delivery?`)
    ) {
      bulkReplay.mutate();
    }
  };

  const rows = listQuery.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-brand-orange" />
          <div>
            <h2 className="text-xl font-semibold">Webhook backlog</h2>
            <p className="text-sm text-muted-foreground">
              Events the OCPP gateway couldn&apos;t deliver in-loop. Only 2xx counts as accepted;
              every other response is retried. Dead rows have aged past the retention window
              (default 7 days) — investigate before replaying.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void listQuery.refetch();
          }}
          data-testid="backlog-refresh"
        >
          <RefreshCw className="mr-1 h-4 w-4" /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Live rows</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl">{counts.live}</div>
            <div className="text-xs text-muted-foreground">Still being retried</div>
          </CardContent>
        </Card>
        <Card className={counts.dead > 0 ? 'border-destructive/40' : ''} data-testid="dead-summary">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Dead-letter</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-2">
            <div>
              <div className="font-mono text-2xl">{counts.dead}</div>
              <div className="text-xs text-muted-foreground">
                Real data loss risk — investigate.
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={counts.dead === 0 || bulkReplay.isPending}
              onClick={handleBulkReplay}
              data-testid="bulk-replay"
            >
              Replay all dead
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2" role="group" aria-label="Filter tab">
        <Button
          size="sm"
          variant={tab === 'dead' ? 'default' : 'outline'}
          onClick={() => setTab('dead')}
          data-testid="tab-dead"
        >
          Dead-letter <Badge className="ml-2">{counts.dead}</Badge>
        </Button>
        <Button
          size="sm"
          variant={tab === 'live' ? 'default' : 'outline'}
          onClick={() => setTab('live')}
          data-testid="tab-live"
        >
          Live <Badge className="ml-2">{counts.live}</Badge>
        </Button>
      </div>

      <section className="rounded-lg border bg-card">
        <BacklogTable
          rows={rows}
          isLoading={listQuery.isLoading}
          emptyHint={tab === 'dead' ? 'No dead-letter rows. Nice.' : 'No live rows in the backlog.'}
          busyIds={busyIds}
          onReplay={handleReplay}
          onPurge={handlePurge}
        />
      </section>
    </div>
  );
}
