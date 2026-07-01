import { useParams } from '@tanstack/react-router';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useMemo } from 'react';

import type { ChargePointSummary } from '@eveys-console/protocol';

import { ChargerSpecChips } from '@/components/ChargerSpecChips';
import { TimeAgo } from '@/components/TimeAgo';
import { Uptime } from '@/components/Uptime';
import { UptimeChip } from '@/components/UptimeChip';
import { CommandsConsole } from '@/components/CommandsConsole';
import { DeviceEventsPanel } from '@/components/DeviceEventsPanel';
import { DiagnosticsHistory } from '@/components/DiagnosticsHistory';
import { OcppLogPanel } from '@/components/OcppLogPanel';
import { ReservationsPanel } from '@/components/ReservationsPanel';
import { StatisticsCard } from '@/components/StatisticsCard';
import { TransactionsHistory } from '@/components/TransactionsHistory';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSubscription } from '@/hooks/use-subscription';
import { chargePointFaultLevel, connectorFaultLevel, faultedConnectors } from '@/lib/fault';
import { describeErrorCode } from '@/lib/ocpp-errors';
import { useIsBelow } from '@/lib/use-breakpoint';
import { cn } from '@/lib/utils';

type Connector = ChargePointSummary['connectors'][number];

export function ChargerDetailPage() {
  const { cpId } = useParams({ strict: false }) as { cpId: string };
  const isPhone = useIsBelow('sm');
  const sub = useSubscription('charge-point', { cp_id: cpId });

  if (sub.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load {cpId}</AlertTitle>
        <AlertDescription>{sub.error}</AlertDescription>
      </Alert>
    );
  }
  // Merge the most recent delta into the rendered row so a
  // BootNotification or StatusNotification visibly updates the page
  // without waiting for the next snapshot refresh. The resolver
  // re-fetches the full row from the gateway on each `cp.boot` /
  // `cp.status` event (see apps/server/src/broker/queries.ts).
  const cp = useMemo<ChargePointSummary | null>(() => {
    if (!sub.snapshot || sub.snapshot.kind !== 'charge-point') return null;
    if (sub.lastDelta && sub.lastDelta.kind === 'charge-point') {
      return sub.lastDelta.row;
    }
    return sub.snapshot.row;
  }, [sub.snapshot, sub.lastDelta]);

  if (sub.loading || !cp) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading charger…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Header cp={cp} />

      <FaultBanner cp={cp} />

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="overview" data-testid="detail-tab-overview">
            Overview
          </TabsTrigger>
          <TabsTrigger value="connectors" data-testid="detail-tab-connectors">
            Connectors
            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-mono">
              {cp.connectors.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="events" data-testid="detail-tab-events">
            Events
          </TabsTrigger>
          <TabsTrigger value="transactions" data-testid="detail-tab-transactions">
            Transactions
          </TabsTrigger>
          <TabsTrigger value="reservations" data-testid="detail-tab-reservations">
            Reservations
          </TabsTrigger>
          <TabsTrigger value="commands" data-testid="detail-tab-commands">
            Commands
          </TabsTrigger>
          <TabsTrigger value="diagnostics" data-testid="detail-tab-diagnostics">
            Diagnostics
          </TabsTrigger>
          <TabsTrigger value="ocpp-log" data-testid="detail-tab-ocpp-log">
            OCPP Log
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <StatisticsCard cpId={cp.cp_id} />
        </TabsContent>

        <TabsContent value="connectors">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Connectors</CardTitle>
            </CardHeader>
            <CardContent className={isPhone ? 'p-0' : undefined}>
              {isPhone ? (
                <ConnectorCards connectors={cp.connectors} />
              ) : (
                <ConnectorTable connectors={cp.connectors} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="events">
          <DeviceEventsPanel cpId={cp.cp_id} />
        </TabsContent>

        <TabsContent value="transactions">
          <TransactionsHistory cpId={cp.cp_id} />
        </TabsContent>

        <TabsContent value="reservations">
          <ReservationsPanel cpId={cp.cp_id} />
        </TabsContent>

        <TabsContent value="commands">
          <CommandsConsole
            cpId={cp.cp_id}
            online={cp.online}
            ocppVersion={cp.ocpp_version ?? null}
            {...(cp.active_reservations ? { activeReservations: cp.active_reservations } : {})}
          />
        </TabsContent>

        <TabsContent value="diagnostics">
          <DiagnosticsHistory cpId={cp.cp_id} />
        </TabsContent>

        <TabsContent value="ocpp-log">
          <OcppLogPanel cpId={cp.cp_id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Banner above the Commands card whenever any connector reports a non-ok
// fault level. One section per faulted connector — error code, friendly
// label, what it means, suggested action, vendor info if present, and
// how long ago the status flipped. Critical/Faulted variant is destructive
// (red); advisory uses the default Alert.
function FaultBanner({ cp }: { cp: ChargePointSummary }) {
  const connectors = faultedConnectors(cp);
  if (connectors.length === 0) return null;
  const overall = chargePointFaultLevel(cp);
  const variant = overall === 'fault' ? 'destructive' : 'default';
  return (
    <Alert variant={variant}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {overall === 'fault'
          ? `Faulted — ${connectors.length} connector${connectors.length === 1 ? '' : 's'}`
          : `Advisory — ${connectors.length} connector${connectors.length === 1 ? '' : 's'} reporting an error`}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        {connectors.map((c) => {
          const info = describeErrorCode(c.error_code);
          const level = connectorFaultLevel(c);
          return (
            <div key={c.connector_id} className="space-y-1">
              <p className="font-medium">
                <span className="font-mono text-xs">connector_id={c.connector_id}</span>
                {' · '}
                <span className="font-mono text-xs">status={c.status}</span>
                {' · '}
                <span className="font-mono text-xs">error_code={c.error_code ?? 'NoError'}</span>
                {' · '}
                <span
                  className={cn(
                    'rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                    level === 'fault'
                      ? 'bg-destructive text-destructive-foreground'
                      : 'bg-amber-500/20 text-amber-900 dark:text-amber-200',
                  )}
                >
                  {info.label}
                </span>
              </p>
              <p className="text-xs">{info.description}</p>
              <p className="text-xs">
                <span className="font-semibold">Suggested action:</span> {info.suggestedAction}
              </p>
              {c.vendor_error_code ? (
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">vendor_error_code: {c.vendor_error_code}</span>
                  {c.info ? <span className="ml-2 italic">{c.info}</span> : null}
                </p>
              ) : c.info ? (
                <p className="text-xs italic text-muted-foreground">{c.info}</p>
              ) : null}
              <p className="text-[10px] text-muted-foreground">
                since <TimeAgo iso={c.last_changed_at} />
              </p>
            </div>
          );
        })}
      </AlertDescription>
    </Alert>
  );
}

function Header({ cp }: { cp: ChargePointSummary }) {
  // Title row with metadata under it, status badges below the title
  // — wraps cleanly at any width without the right edge competing
  // with the title.
  return (
    <div className="space-y-2">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-all font-mono text-lg font-semibold sm:text-xl">{cp.cp_id}</h2>
          <ChargerSpecChips model={cp.model} />
        </div>
        <p className="text-sm text-muted-foreground">
          {cp.vendor ?? '—'} / {cp.model ?? '—'} · firmware {cp.firmware_version ?? '?'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={cp.online ? 'success' : 'muted'}>{cp.online ? 'online' : 'offline'}</Badge>
        {cp.ocpp_version ? (
          <Badge
            variant="secondary"
            className="font-mono text-xs"
            title="OCPP subprotocol negotiated on the WS handshake"
            data-testid="header-ocpp-version"
          >
            {formatOcppVersion(cp.ocpp_version)}
          </Badge>
        ) : null}
        <Badge variant="secondary" className="font-mono text-xs">
          last_status: {cp.last_status ?? '—'}
        </Badge>
        {cp.last_heartbeat_at ? (
          <Badge variant="secondary" className="font-mono text-xs" data-testid="header-heartbeat">
            heartbeat: <TimeAgo iso={cp.last_heartbeat_at} className="ml-1" />
          </Badge>
        ) : null}
        {cp.pod_id ? (
          <Badge variant="secondary" className="font-mono text-xs" title={cp.pod_id}>
            pod: {cp.pod_id.length > 12 ? `${cp.pod_id.slice(0, 12)}…` : cp.pod_id}
          </Badge>
        ) : null}
        {cp.online && cp.last_boot_at ? (
          <Badge
            variant="secondary"
            className="font-mono text-xs"
            title={`booted at ${cp.last_boot_at}`}
          >
            since boot: <Uptime iso={cp.last_boot_at} className="ml-1" />
          </Badge>
        ) : null}
        {/* Operational uptime % over a range (distinct from the
            time-since-boot badge above). Refetches when the charger
            comes back online — last_boot_at is the natural identity
            since a fresh boot means an outage just closed. */}
        <UptimeChip cpId={cp.cp_id} refetchKey={cp.last_boot_at} />
      </div>
    </div>
  );
}

function ConnectorTable({ connectors }: { connectors: Connector[] }) {
  if (connectors.length === 0) {
    return <p className="text-sm text-muted-foreground">No connectors reported.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>connector_id</TableHead>
          <TableHead>status</TableHead>
          <TableHead>error_code</TableHead>
          <TableHead>last_changed_at</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connectors.map((c) => (
          <TableRow key={c.connector_id}>
            <TableCell className="font-mono">{c.connector_id}</TableCell>
            <TableCell>{c.status}</TableCell>
            <TableCell className="font-mono text-xs">
              {c.error_code && c.error_code !== 'NoError' ? (
                <span className="text-destructive">{c.error_code}</span>
              ) : (
                <span className="text-muted-foreground">{c.error_code ?? '—'}</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              <TimeAgo iso={c.last_changed_at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConnectorCards({ connectors }: { connectors: Connector[] }) {
  if (connectors.length === 0) {
    return <p className="px-4 pb-4 text-sm text-muted-foreground">No connectors reported.</p>;
  }
  // Vertical stack of mini-cards; each shows the same fields the
  // table does, but in a single-column layout that fits 360 px wide.
  return (
    <ul className="divide-y">
      {connectors.map((c) => (
        <li key={c.connector_id} className="space-y-1.5 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm">connector {c.connector_id}</span>
            <Badge variant={connectorVariant(c)} className="text-xs">
              {c.status}
            </Badge>
          </div>
          <dl className="space-y-0.5 text-xs">
            <Field
              k="error_code"
              v={
                c.error_code && c.error_code !== 'NoError' ? (
                  <span className="text-destructive">{c.error_code}</span>
                ) : (
                  <span className="text-muted-foreground">{c.error_code ?? '—'}</span>
                )
              }
            />
            <Field k="last_changed_at" v={<TimeAgo iso={c.last_changed_at} />} />
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="truncate font-mono text-foreground/80">{v}</dd>
    </div>
  );
}

/**
 * Render the gateway-stored ocpp_version string as "OCPP 1.6" / "OCPP 2.0.1".
 * Anything we don't recognise prints verbatim (with the "OCPP " prefix)
 * so a future spec rev shows up in the UI even before the format helper
 * learns about it.
 */
export function formatOcppVersion(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'OCPP ?';
  // Gateway writes `ocpp1.6` / `ocpp2.0.1` — strip the prefix and
  // add a space for readability.
  if (trimmed.toLowerCase().startsWith('ocpp')) {
    return `OCPP ${trimmed.slice(4)}`;
  }
  return `OCPP ${trimmed}`;
}

/**
 * True when the charger speaks an OCPP profile that includes
 * GetLog (OCPP 1.6 Security Extensions or OCPP 2.0.1).
 *
 * Today we have no protocol-level signal for whether a 1.6 charger
 * has the Security Extensions profile. The conservative behaviour:
 * treat plain 1.6 as "no GetLog" and let operators opt into the
 * Advanced disclosure when they know their charger supports it.
 * Once 2.0.1 ships the gateway-side ocpp_version becomes "ocpp2.0.1"
 * and GetLog is part of core.
 */
export function supportsGetLog(ocppVersion: string | null | undefined): boolean {
  if (!ocppVersion) return false;
  const v = ocppVersion.toLowerCase();
  return v.startsWith('ocpp2');
}

function connectorVariant(c: Connector): 'success' | 'warning' | 'destructive' | 'muted' {
  if (c.error_code && c.error_code !== 'NoError') return 'destructive';
  switch (c.status) {
    case 'Charging':
    case 'Available':
      return 'success';
    case 'Preparing':
    case 'Finishing':
    case 'Reserved':
      return 'warning';
    case 'Faulted':
      return 'destructive';
    default:
      return 'muted';
  }
}
