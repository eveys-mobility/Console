// Device-authorization console (#0013). Operators see pending devices
// here and Approve / Reject them. Approved devices listed too so an
// operator can Revoke (force-disconnects any live WS).
//
// Pending list polls every 5 s so a new charger shows up without
// requiring a manual refresh; SSE-pushed updates are a follow-up.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import {
  approveAuthorization,
  listAuthorizations,
  rejectAuthorization,
  revokeAuthorization,
  type Authorization,
  type AuthorizationStatus,
} from '@/api/authorizations-client';
import { Badge } from '@/components/ui/badge';
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
const DECIDED_REFRESH_MS = 30000;

function StatusBadge({ status }: { status: AuthorizationStatus }) {
  if (status === 'approved') return <Badge variant="default">Approved</Badge>;
  if (status === 'pending') return <Badge variant="secondary">Pending</Badge>;
  return <Badge variant="destructive">{status === 'rejected' ? 'Rejected' : 'Revoked'}</Badge>;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface RowsProps {
  title: string;
  rows: Authorization[];
  isPending: boolean;
  isLoading: boolean;
  emptyHint: string;
  onApprove?: (cpId: string) => void;
  onReject?: (cpId: string) => void;
  onRevoke?: (cpId: string) => void;
  busy: Set<string>;
}

function AuthorizationsTable({
  title,
  rows,
  isPending,
  isLoading,
  emptyHint,
  onApprove,
  onReject,
  onRevoke,
  busy,
}: RowsProps) {
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-base font-semibold">{title}</h3>
        <span className="text-sm text-muted-foreground">{rows.length}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>cp_id</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>{isPending ? 'Requested' : 'Decided'}</TableHead>
            <TableHead>{isPending ? 'Last attempt' : 'Decided by'}</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Action</TableHead>
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
              <TableRow key={row.cp_id}>
                <TableCell className="font-mono text-sm">{row.cp_id}</TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {isPending ? formatTime(row.requested_at) : formatTime(row.decided_at)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {isPending ? formatTime(row.last_attempt_at) : (row.decided_by ?? '—')}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <div className="font-mono">{row.last_attempt_ip ?? '—'}</div>
                  <div className="truncate" title={row.last_attempt_user_agent ?? ''}>
                    {row.last_attempt_user_agent ?? '—'}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {isPending && onApprove && onReject ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={busy.has(row.cp_id)}
                        onClick={() => onApprove(row.cp_id)}
                      >
                        Approve
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
                  ) : onRevoke && row.status === 'approved' ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy.has(row.cp_id)}
                      onClick={() => onRevoke(row.cp_id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
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
    queryFn: () => listAuthorizations(token!, { status: 'pending' }),
    enabled: !!token,
    refetchInterval: PENDING_REFRESH_MS,
  });

  const decided = useQuery({
    queryKey: ['authorizations', 'decided'],
    // No status filter — fetch the recent set, render the non-pending
    // rows in the lower table.
    queryFn: () => listAuthorizations(token!, { limit: 200 }),
    enabled: !!token,
    refetchInterval: DECIDED_REFRESH_MS,
  });

  // `busy` keeps per-row buttons disabled during mutation in-flight
  // so a double-click can't fire two POSTs. Cleared in `onSettled`.
  const busy = new Set<string>();

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['authorizations', 'pending'] }),
      qc.invalidateQueries({ queryKey: ['authorizations', 'decided'] }),
    ]);

  const approve = useMutation({
    mutationFn: (cpId: string) => approveAuthorization(token!, cpId),
    onSettled: () => invalidate(),
  });
  const reject = useMutation({
    mutationFn: (cpId: string) => rejectAuthorization(token!, cpId),
    onSettled: () => invalidate(),
  });
  const revoke = useMutation({
    mutationFn: (cpId: string) => revokeAuthorization(token!, cpId),
    onSettled: () => invalidate(),
  });

  if (approve.isPending && approve.variables) busy.add(approve.variables);
  if (reject.isPending && reject.variables) busy.add(reject.variables);
  if (revoke.isPending && revoke.variables) busy.add(revoke.variables);

  const pendingRows = pending.data ?? [];
  const decidedRows = (decided.data ?? []).filter((r) => r.status !== 'pending');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand-orange" />
        <div>
          <h2 className="text-xl font-semibold">Device Authorizations</h2>
          <p className="text-sm text-muted-foreground">
            New chargers get a {`≈`} 3-minute grace window to be approved before the gateway
            force-disconnects them. Approve known devices below; reject anything you don&apos;t
            recognize.
          </p>
        </div>
      </div>

      <AuthorizationsTable
        title="Pending"
        rows={pendingRows}
        isPending
        isLoading={pending.isLoading}
        emptyHint="No devices waiting for approval."
        onApprove={(cpId) => approve.mutate(cpId)}
        onReject={(cpId) => reject.mutate(cpId)}
        busy={busy}
      />

      <AuthorizationsTable
        title="Decided"
        rows={decidedRows}
        isPending={false}
        isLoading={decided.isLoading}
        emptyHint="No prior decisions."
        onRevoke={(cpId) => revoke.mutate(cpId)}
        busy={busy}
      />
    </div>
  );
}
