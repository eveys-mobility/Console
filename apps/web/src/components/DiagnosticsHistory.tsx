// Per-charger diagnostics history card. Lives below the Connectors
// card on the device page; polls /sys/diagnostics every 5 seconds via
// TanStack Query so a fresh upload appears within one tick.
//
// The contract here is intentionally narrow — list, download, delete.
// Issuing new upload URLs lives in CommandsDrawer (where the
// GetDiagnostics / GetLog forms are). Splitting the surfaces keeps
// this card a passive read view; the ops-action surface is the drawer.

import { Download, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  deleteDiagnostic,
  downloadUrl,
  fetchDiagnostics,
  type DiagnosticsArtifact,
} from '@/api/diagnostics-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatAbsoluteTime } from '@/lib/time';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toaster';
import { useConsoleClient } from '@/lib/ws-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface Props {
  cpId: string;
}

const REFETCH_MS = 5000;

export function DiagnosticsHistory({ cpId }: Props) {
  const { token } = useConsoleClient();
  const { toast } = useToast();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['diagnostics', cpId],
    queryFn: () => fetchDiagnostics(token ?? '', cpId),
    refetchInterval: REFETCH_MS,
    enabled: !!token,
  });

  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const onDelete = async (id: number) => {
    if (!token) return;
    setPendingDelete(id);
    try {
      await deleteDiagnostic(token, id);
      toast({ title: 'Diagnostics', description: 'Artefact deleted.' });
      void qc.invalidateQueries({ queryKey: ['diagnostics', cpId] });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Diagnostics',
        description: err instanceof Error ? err.message : 'Delete failed',
      });
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Diagnostics history</CardTitle>
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
        ) : !query.data || query.data.artifacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No diagnostics uploads yet.</p>
        ) : (
          <ArtifactTable
            rows={query.data.artifacts}
            token={token ?? ''}
            pendingDelete={pendingDelete}
            onDelete={onDelete}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ArtifactTable({
  rows,
  token,
  pendingDelete,
  onDelete,
}: {
  rows: DiagnosticsArtifact[];
  token: string;
  pendingDelete: number | null;
  onDelete: (id: number) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>issued</TableHead>
          <TableHead>command</TableHead>
          <TableHead>status</TableHead>
          <TableHead>size</TableHead>
          <TableHead>sha256</TableHead>
          <TableHead className="text-right">actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell
              className="text-xs text-muted-foreground"
              title={formatAbsoluteTime(new Date(r.issued_at * 1000).toISOString())}
            >
              {formatRelativeFromEpoch(r.issued_at)}
            </TableCell>
            <TableCell className="font-mono text-xs">{r.command}</TableCell>
            <TableCell>
              <StatusBadge status={r.status} />
            </TableCell>
            <TableCell className="font-mono text-xs">
              {r.file_size === null ? '—' : formatBytes(r.file_size)}
            </TableCell>
            <TableCell className="font-mono text-xs" title={r.file_sha256 ?? undefined}>
              {r.file_sha256 === null ? '—' : `${r.file_sha256.slice(0, 8)}…`}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                {r.status === 'uploaded' ? (
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    aria-label={`Download artefact ${r.id}`}
                  >
                    <a href={downloadUrl(token, r.id)} download>
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingDelete === r.id}
                  onClick={() => onDelete(r.id)}
                  aria-label={`Delete artefact ${r.id}`}
                >
                  {pendingDelete === r.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusBadge({ status }: { status: DiagnosticsArtifact['status'] }) {
  switch (status) {
    case 'uploaded':
      return <Badge variant="success">uploaded</Badge>;
    case 'pending':
      return (
        <Badge variant="warning" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          pending
        </Badge>
      );
    case 'expired':
      return <Badge variant="muted">expired</Badge>;
    case 'failed':
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="muted">{status}</Badge>;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelativeFromEpoch(seconds: number): string {
  const delta = Math.round(Date.now() / 1000 - seconds);
  if (delta < 5) return 'now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86_400)}d ago`;
}
