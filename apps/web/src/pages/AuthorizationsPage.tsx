// Device-authorization console (#0013). Operators see pending devices
// here and Authorize / Reject them. The gateway's list endpoint returns
// only the pending set — Redis-backed with a 1 h TTL — so there's no
// "decided" tab; rejected / authorized / revoked outcomes live in the
// gateway's own audit log.
//
// Pending list polls every 5 s so a new charger shows up without
// requiring a manual refresh; SSE-pushed updates are a follow-up.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import {
  authorizeDevice,
  listAuthorizations,
  rejectAuthorization,
  type PendingAuthorization,
} from '@/api/authorizations-client';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConsoleClient } from '@/lib/ws-context';

const PENDING_REFRESH_MS = 5000;

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface RowsProps {
  rows: PendingAuthorization[];
  isLoading: boolean;
  emptyHint: string;
  onAuthorize: (cpId: string) => void;
  onReject: (cpId: string) => void;
  busy: Set<string>;
}

function AuthorizationsTable({
  rows,
  isLoading,
  emptyHint,
  onAuthorize,
  onReject,
  busy,
}: RowsProps) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-base font-semibold">Pending</h3>
        <span className="text-sm text-muted-foreground">{rows.length}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>cp_id</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Identity</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={7} className="text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-sm text-muted-foreground">
                {emptyHint}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.cp_id}>
                <TableCell className="font-mono text-sm">{row.cp_id}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatTime(row.first_seen_at)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatTime(row.last_seen_at)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.attempts}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <div>{row.vendor ?? '—'}</div>
                  <div className="truncate" title={row.model ?? ''}>
                    {row.model ?? '—'}
                  </div>
                  <div className="font-mono">{row.firmware ?? '—'}</div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <div className="font-mono">{row.peer_ip ?? '—'}</div>
                  <div className="truncate" title={row.user_agent ?? ''}>
                    {row.user_agent ?? '—'}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={busy.has(row.cp_id)}
                      onClick={() => onAuthorize(row.cp_id)}
                    >
                      Authorize
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy.has(row.cp_id)}
                      onClick={() => onReject(row.cp_id)}
                    >
                      Reject
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

export function AuthorizationsPage() {
  const { token } = useConsoleClient();
  const qc = useQueryClient();

  const pending = useQuery({
    queryKey: ['authorizations', 'pending'],
    queryFn: () => listAuthorizations(token!),
    enabled: !!token,
    refetchInterval: PENDING_REFRESH_MS,
  });

  // `busy` keeps per-row buttons disabled during mutation in-flight
  // so a double-click can't fire two POSTs. Cleared in `onSettled`.
  const busy = new Set<string>();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['authorizations', 'pending'] });

  const authorize = useMutation({
    mutationFn: (cpId: string) => authorizeDevice(token!, cpId),
    onSettled: () => invalidate(),
  });
  const reject = useMutation({
    mutationFn: (cpId: string) => rejectAuthorization(token!, cpId),
    onSettled: () => invalidate(),
  });

  if (authorize.isPending && authorize.variables) busy.add(authorize.variables);
  if (reject.isPending && reject.variables) busy.add(reject.variables);

  const pendingRows = pending.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand-orange" />
        <div>
          <h2 className="text-xl font-semibold">Device Authorizations</h2>
          <p className="text-sm text-muted-foreground">
            New chargers appear here while pending (1-hour window). Authorize known devices; reject
            anything you don&apos;t recognize. The gateway retains the outcome in its own audit log
            — this page only lists what&apos;s still waiting for a decision.
          </p>
        </div>
      </div>

      <AuthorizationsTable
        rows={pendingRows}
        isLoading={pending.isLoading}
        emptyHint="No devices waiting for authorization."
        onAuthorize={(cpId) => authorize.mutate(cpId)}
        onReject={(cpId) => reject.mutate(cpId)}
        busy={busy}
      />
    </div>
  );
}
