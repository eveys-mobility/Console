// Device-authorization console. Operators see pending devices here and
// Authorize them. The gateway's list endpoint returns only the pending
// set — Redis-backed — so this page shows what's waiting for a
// decision. Reject was removed: dropping the pending row doesn't
// actually block reconnect (the same cp_id walks straight back onto
// the queue), so it was a confusing action; the IP rate limit is the
// real block.
//
// Pending list polls every 5 s so a new charger shows up without
// requiring a manual refresh; SSE-pushed updates are a follow-up.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import {
  authorizeDevice,
  listAuthorizations,
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
  busy: Set<string>;
}

function AuthorizationsTable({ rows, isLoading, emptyHint, onAuthorize, busy }: RowsProps) {
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
            <TableHead>Attempts</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={4} className="text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-sm text-muted-foreground">
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
                <TableCell className="text-sm text-muted-foreground">{row.attempts}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busy.has(row.cp_id)}
                    onClick={() => onAuthorize(row.cp_id)}
                  >
                    Authorize
                  </Button>
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

  if (authorize.isPending && authorize.variables) busy.add(authorize.variables);

  const pendingRows = pending.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-brand-orange" />
        <div>
          <h2 className="text-xl font-semibold">Device Authorizations</h2>
          <p className="text-sm text-muted-foreground">
            New chargers appear here while pending. Authorize known devices; unknown ones age out
            automatically. Rows here are only the identifiers the gateway can promise are correct —
            vendor / model / firmware from a first BootNotification are shown on the fleet detail
            page after authorization, not here.
          </p>
        </div>
      </div>

      <AuthorizationsTable
        rows={pendingRows}
        isLoading={pending.isLoading}
        emptyHint="No devices waiting for authorization."
        onAuthorize={(cpId) => authorize.mutate(cpId)}
        busy={busy}
      />
    </div>
  );
}
