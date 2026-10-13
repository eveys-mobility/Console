import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Grid3x3,
  List as ListIcon,
  Loader2,
  Plug,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { mergeChargePoint, type ChargePointSummary } from '@eveys-console/protocol';

import { ChargerSpecChips } from '@/components/ChargerSpecChips';
import { ConnectorDataNotice, physicalConnectors } from '@/components/ConnectorDataNotice';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useSubscription } from '@/hooks/use-subscription';
import { chargePointFaultLevel, type FaultLevel } from '@/lib/fault';
import { formatOcppVersion } from '@/lib/ocpp-version';
import { formatRelativeTime, formatUptime } from '@/lib/time';
import { useIsBelow } from '@/lib/use-breakpoint';
import { cn } from '@/lib/utils';

type ViewMode = 'table' | 'grid';
type OnlineFilter = 'all' | 'online' | 'offline';

const STATUSES = [
  'all',
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;

const VIEW_KEY = 'eveys-console.fleet-view';

export function FleetPage() {
  const isPhone = useIsBelow('sm');

  // Persist the user's view-mode pick across navigations. Below
  // `sm` we force grid (the table doesn't fit on a phone) but
  // we don't overwrite the stored preference — when the user
  // resizes back up to desktop, their chosen view returns.
  const [savedView, setSavedView] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_KEY) as ViewMode) ?? 'table',
  );
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, savedView);
  }, [savedView]);
  const view: ViewMode = isPhone ? 'grid' : savedView;

  // Server-side filters — pushed into the subscription params so they
  // cut the whole device set, not just the loaded page. The server
  // accepts `online`, `vendor`, `ocpp_version`, `last_status`,
  // `cp_id_contains`.
  const [onlineFilter, setOnlineFilter] = useState<OnlineFilter>('all');
  const [vendorFilter, setVendorFilter] = useState<string>('');
  // 'all' = no filter. Closed set today (only OCPP 1.6 in the wild);
  // adding 2.0.1 as an option even though no rows match yet so the
  // dropdown is forward-compatible without a code change when 2.0.1
  // chargers start showing up.
  const [ocppVersionFilter, setOcppVersionFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number]>('all');
  const [pageSize, setPageSize] = useState<number>(100);
  const [page, setPage] = useState<number>(1);

  // `faultsOnly` mirrors the `?faults=1` search param so the
  // SystemPage Faults tile can deep-link straight to a filtered view
  // and the URL stays shareable. The toggle's onChange updates the
  // URL; the URL is the source of truth on mount.
  const navigate = useNavigate({ from: '/inspect/charge-points' });
  const search$ = useSearch({ from: '/inspect/charge-points' }) as { faults?: boolean };
  const faultsOnly = !!search$.faults;
  const setFaultsOnly = (next: boolean) => {
    void navigate({
      search: (prev: Record<string, unknown>) => {
        const out = { ...prev };
        if (next) out.faults = true;
        else delete out.faults;
        return out;
      },
      replace: true,
    });
  };

  // Debounce the typed search box so each keystroke doesn't re-
  // subscribe. The committed value is what flows to the server as
  // `cp_id_contains`.
  const [searchCommitted, setSearchCommitted] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchCommitted(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Any server-side filter change invalidates the current page — go
  // back to page 1 so the operator doesn't end up looking at an empty
  // page that exists only in the previous filter set.
  useEffect(() => {
    setPage(1);
  }, [onlineFilter, vendorFilter, ocppVersionFilter, statusFilter, searchCommitted, pageSize]);

  // Build subscription params. Re-subscribes when any of these change
  // (use-subscription stringifies params and uses that as a dep).
  const subParams = useMemo<Record<string, string | number | boolean>>(() => {
    const p: Record<string, string | number | boolean> = { page, page_size: pageSize };
    if (onlineFilter === 'online') p.online = true;
    if (onlineFilter === 'offline') p.online = false;
    if (vendorFilter.trim()) p.vendor = vendorFilter.trim();
    if (ocppVersionFilter !== 'all') p.ocpp_version = ocppVersionFilter;
    if (statusFilter !== 'all') p.last_status = statusFilter;
    if (searchCommitted) p.cp_id_contains = searchCommitted;
    return p;
  }, [
    onlineFilter,
    vendorFilter,
    ocppVersionFilter,
    statusFilter,
    searchCommitted,
    pageSize,
    page,
  ]);

  const sub = useSubscription('charge-points', subParams);

  // Apply the latest delta on top of the snapshot. Filtering happens
  // server-side; the only client-side cut left is the faults-only
  // toggle, applied below. `total` / `serverPageSize` come from the
  // gateway's page-mode response and drive the "Showing N–M of T"
  // line in the footer.
  const { allRows, total, serverPageSize } = useMemo<{
    allRows: ChargePointSummary[];
    total: number | null;
    serverPageSize: number | null;
  }>(() => {
    if (!sub.snapshot || sub.snapshot.kind !== 'charge-points') {
      return { allRows: [], total: null, serverPageSize: null };
    }
    const byId = new Map<string, ChargePointSummary>(sub.snapshot.rows.map((r) => [r.cp_id, r]));
    if (sub.lastDelta && sub.lastDelta.kind === 'charge-points') {
      const d = sub.lastDelta;
      if (d.op === 'upsert' && d.row)
        byId.set(d.row.cp_id, mergeChargePoint(byId.get(d.row.cp_id), d.row));
      if (d.op === 'remove' && d.cp_id) byId.delete(d.cp_id);
    }
    return {
      allRows: Array.from(byId.values()).sort((a, b) => a.cp_id.localeCompare(b.cp_id)),
      total: typeof sub.snapshot.total === 'number' ? sub.snapshot.total : null,
      serverPageSize: typeof sub.snapshot.page_size === 'number' ? sub.snapshot.page_size : null,
    };
  }, [sub.snapshot, sub.lastDelta]);

  // Vendor list for the autocomplete (datalist) — sourced from the
  // current page so it doesn't require a separate distinct query.
  const knownVendors = useMemo(
    () => Array.from(new Set(allRows.map((r) => r.vendor).filter((v): v is string => !!v))).sort(),
    [allRows],
  );

  // Only the faults-only toggle filters client-side now — it's a
  // computed predicate over per-connector error codes that the
  // gateway list endpoint doesn't expose directly. Search, status,
  // online and vendor are all server-side.
  const rows = useMemo(() => {
    if (!faultsOnly) return allRows;
    return allRows.filter((r) => chargePointFaultLevel(r) !== 'ok');
  }, [allRows, faultsOnly]);

  if (sub.error && !sub.snapshot) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load charge points</AlertTitle>
        <AlertDescription>{sub.error}</AlertDescription>
      </Alert>
    );
  }
  if (sub.loading || !sub.snapshot) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading charge points…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {sub.error ? (
        <Alert>
          <AlertTitle>Live data unavailable</AlertTitle>
          <AlertDescription>{sub.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            Charge points
            {total !== null ? ` — ${total} total` : ''}
          </h2>
          <p className="text-sm text-muted-foreground">
            Live; updates on every BootNotification and StatusNotification.
          </p>
        </div>
        {/* View toggle hidden below `sm` — phones force grid mode
            because the table needs columns we can't render at that
            width. The stored pref still survives. */}
        {!isPhone ? <ViewToggle view={view} onChange={setSavedView} /> : null}
      </div>

      <FilterBar
        isPhone={isPhone}
        onlineFilter={onlineFilter}
        onOnlineChange={setOnlineFilter}
        vendorFilter={vendorFilter}
        onVendorChange={setVendorFilter}
        knownVendors={knownVendors}
        ocppVersionFilter={ocppVersionFilter}
        onOcppVersionChange={setOcppVersionFilter}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        faultsOnly={faultsOnly}
        onFaultsOnlyChange={setFaultsOnly}
        search={search}
        onSearchChange={setSearch}
      />

      {view === 'table' ? <FleetTable rows={rows} /> : <FleetGrid rows={rows} />}

      <Pagination
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        page={page}
        onPageChange={setPage}
        total={total}
        serverPageSize={serverPageSize}
        loadedRowCount={rows.length}
      />
    </div>
  );
}

interface FilterBarProps {
  isPhone: boolean;
  onlineFilter: OnlineFilter;
  onOnlineChange: (v: OnlineFilter) => void;
  vendorFilter: string;
  onVendorChange: (v: string) => void;
  knownVendors: string[];
  /** 'all' = no filter. Anything else (e.g. 'ocpp1.6') is the
   *  gateway-side wire value passed through unchanged. */
  ocppVersionFilter: string;
  onOcppVersionChange: (v: string) => void;
  statusFilter: (typeof STATUSES)[number];
  onStatusChange: (v: (typeof STATUSES)[number]) => void;
  faultsOnly: boolean;
  onFaultsOnlyChange: (v: boolean) => void;
  search: string;
  onSearchChange: (v: string) => void;
}

function FilterBar(props: FilterBarProps) {
  const activeCount = countActiveFilters(props);

  if (props.isPhone) {
    return (
      <div className="flex items-center gap-2">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-2" aria-label="Open filters">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
              {activeCount > 0 ? (
                <Badge variant="secondary" className="ml-0.5 h-5 px-1.5 text-[10px]">
                  {activeCount}
                </Badge>
              ) : null}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
            <SheetHeader className="pb-2">
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-3 pt-2">
              <FilterFields {...props} stretch />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-card/40 p-3">
      <FilterFields {...props} />
    </div>
  );
}

function countActiveFilters(p: FilterBarProps): number {
  let n = 0;
  if (p.search.trim()) n++;
  if (p.onlineFilter !== 'all') n++;
  if (p.vendorFilter.trim()) n++;
  if (p.ocppVersionFilter !== 'all') n++;
  if (p.statusFilter !== 'all') n++;
  if (p.faultsOnly) n++;
  return n;
}

// Renders the four filter fields. `stretch` makes each field
// `w-full` for the mobile sheet layout; the desktop bar uses fixed
// widths so the row remains compact.
function FilterFields({
  onlineFilter,
  onOnlineChange,
  vendorFilter,
  onVendorChange,
  knownVendors,
  ocppVersionFilter,
  onOcppVersionChange,
  statusFilter,
  onStatusChange,
  faultsOnly,
  onFaultsOnlyChange,
  search,
  onSearchChange,
  stretch = false,
}: FilterBarProps & { stretch?: boolean }) {
  const fieldFull = stretch ? 'w-full' : '';
  return (
    <>
      <FilterField label="cp_id search" hint="server-side · substring" stretch={stretch}>
        <div className={cn('relative', fieldFull)}>
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.currentTarget.value)}
            placeholder="e.g. 617b5675"
            className={cn('h-9 pl-8', stretch ? 'w-full' : 'w-[260px]')}
          />
        </div>
      </FilterField>

      <FilterField label="Online" hint="server-side" stretch={stretch}>
        <Select
          value={onlineFilter}
          onChange={(e) => onOnlineChange(e.currentTarget.value as OnlineFilter)}
          className={cn(stretch ? 'w-full' : 'w-[120px]')}
        >
          <option value="all">All</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </Select>
      </FilterField>

      <FilterField label="Vendor" hint="server-side · exact match" stretch={stretch}>
        <Input
          list="vendor-options"
          value={vendorFilter}
          onChange={(e) => onVendorChange(e.currentTarget.value)}
          placeholder="any"
          className={cn('h-9', stretch ? 'w-full' : 'w-[160px]')}
        />
        <datalist id="vendor-options">
          {knownVendors.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </FilterField>

      <FilterField label="OCPP" hint="server-side" stretch={stretch}>
        <Select
          value={ocppVersionFilter}
          onChange={(e) => onOcppVersionChange(e.currentTarget.value)}
          className={cn(stretch ? 'w-full' : 'w-[140px]')}
          aria-label="OCPP version"
        >
          <option value="all">Any</option>
          <option value="ocpp1.6">OCPP 1.6</option>
          {/* 2.0.1 not in the wild yet on this fleet; left in the
              dropdown so the option is forward-compatible without a
              code change when 2.0.1 chargers start showing up. */}
          <option value="ocpp2.0.1">OCPP 2.0.1</option>
        </Select>
      </FilterField>

      <FilterField label="Status" hint="server-side" stretch={stretch}>
        <Select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.currentTarget.value as (typeof STATUSES)[number])}
          className={cn(stretch ? 'w-full' : 'w-[160px]')}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === 'all' ? 'Any' : s}
            </option>
          ))}
        </Select>
      </FilterField>

      <FilterField label="Faults" hint="loaded page" stretch={stretch}>
        <Button
          variant={faultsOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => onFaultsOnlyChange(!faultsOnly)}
          aria-pressed={faultsOnly}
          className={cn('h-9 gap-1.5', stretch ? 'w-full' : '')}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Faults only
        </Button>
      </FilterField>
    </>
  );
}

function FilterField({
  label,
  hint,
  children,
  stretch = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  stretch?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1', stretch && 'w-full')}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        {hint ? <span className="ml-1 normal-case text-muted-foreground/60">· {hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5">
      <Button
        variant={view === 'table' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => onChange('table')}
        aria-label="Table view"
        aria-pressed={view === 'table'}
        className="h-7 px-2"
      >
        <ListIcon className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant={view === 'grid' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => onChange('grid')}
        aria-label="Grid view"
        aria-pressed={view === 'grid'}
        className="h-7 px-2"
      >
        <Grid3x3 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function FleetTable({ rows }: { rows: ChargePointSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (cp: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cp)) next.delete(cp);
      else next.add(cp);
      return next;
    });

  if (rows.length === 0) return <EmptyState />;

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px]"></TableHead>
            <TableHead>cp_id</TableHead>
            <TableHead>online</TableHead>
            <TableHead>pod</TableHead>
            <TableHead>last status</TableHead>
            <TableHead>connectors</TableHead>
            <TableHead>vendor / model</TableHead>
            <TableHead>firmware</TableHead>
            <TableHead>OCPP</TableHead>
            <TableHead>last heartbeat</TableHead>
            <TableHead>uptime</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <FleetTableRow
              key={row.cp_id}
              row={row}
              isOpen={expanded.has(row.cp_id)}
              onToggle={() => toggle(row.cp_id)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FleetTableRow({
  row,
  isOpen,
  onToggle,
}: {
  row: ChargePointSummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow>
        <TableCell className="w-[40px]">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            className="h-6 w-6 p-0"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            <Plug
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                isOpen ? 'rotate-90 text-primary' : 'text-muted-foreground',
              )}
            />
          </Button>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <FaultDot level={chargePointFaultLevel(row)} />
            <Link
              to="/inspect/charge-points/$cpId"
              params={{ cpId: row.cp_id } as never}
              className="font-mono text-xs text-primary underline-offset-2 hover:underline"
            >
              {row.cp_id}
            </Link>
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={row.online ? 'success' : 'muted'}>
            {row.online ? 'online' : 'offline'}
          </Badge>
        </TableCell>
        <TableCell>
          <PodCell podId={row.pod_id} />
        </TableCell>
        <TableCell>
          <StatusPill status={row.last_status} />
        </TableCell>
        <TableCell>
          <ConnectorsSummary connectors={physicalConnectors(row)} />
          <ConnectorDataNotice cp={row} />
        </TableCell>
        <TableCell className="text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <VendorModel vendor={row.vendor} model={row.model} />
            <ChargerSpecChips model={row.model} compact />
          </div>
        </TableCell>
        <TableCell className="font-mono text-xs">{row.firmware_version ?? '—'}</TableCell>
        <TableCell
          className="font-mono text-xs text-muted-foreground"
          data-testid="fleet-row-ocpp-version"
        >
          {row.ocpp_version ? formatOcppVersion(row.ocpp_version) : '—'}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {formatRelativeTime(row.last_heartbeat_at)}
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {row.online ? formatUptime(row.last_boot_at) : '—'}
        </TableCell>
      </TableRow>
      {isOpen ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={11} className="p-0">
            {row.connectors_state === 'unavailable' && physicalConnectors(row).length === 0 ? (
              <ConnectorDataNotice cp={row} />
            ) : (
              <ConnectorDetail connectors={physicalConnectors(row)} cpId={row.cp_id} />
            )}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function FleetGrid({ rows }: { rows: ChargePointSummary[] }) {
  if (rows.length === 0) return <EmptyState />;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => (
        <FleetCard key={row.cp_id} row={row} />
      ))}
    </div>
  );
}

function FleetCard({ row }: { row: ChargePointSummary }) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <Link
            to="/inspect/charge-points/$cpId"
            params={{ cpId: row.cp_id } as never}
            className="block min-w-0 flex-1 truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
            title={row.cp_id}
          >
            {row.cp_id}
          </Link>
          <Badge variant={row.online ? 'success' : 'muted'} className="shrink-0">
            {row.online ? 'online' : 'offline'}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <ChargerSpecChips model={row.model} />
        </div>

        <div>
          <StatusPill status={row.last_status} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {physicalConnectors(row).length === 0 ? (
            row.connectors_state === 'unavailable' ? null : (
              <span className="text-xs text-muted-foreground">no connectors reported</span>
            )
          ) : (
            physicalConnectors(row).map((c) => <ConnectorDot key={c.connector_id} connector={c} />)
          )}
          <ConnectorDataNotice cp={row} />
        </div>

        <dl className="space-y-1 text-xs text-muted-foreground">
          <Row k="vendor" v={vendorModelText(row.vendor, row.model)} />
          <Row k="firmware" v={row.firmware_version ?? '—'} />
          <Row k="OCPP" v={row.ocpp_version ? formatOcppVersion(row.ocpp_version) : '—'} />
          <Row k="heartbeat" v={formatRelativeTime(row.last_heartbeat_at)} />
          {row.online && row.last_boot_at ? (
            <Row k="uptime" v={formatUptime(row.last_boot_at)} />
          ) : null}
          {row.pod_id ? <Row k="pod" v={row.pod_id} /> : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{k}</dt>
      <dd className="truncate font-mono text-foreground/80" title={v}>
        {v}
      </dd>
    </div>
  );
}

// Render the vendor/model pair so a missing side never produces a
// leading em-dash. "Eveys / Eveys-22kW-AC" with both; "Eveys" or
// "Eveys-22kW-AC" with one; "—" with neither.
function VendorModel({
  vendor,
  model,
}: {
  vendor: string | null | undefined;
  model: string | null | undefined;
}) {
  if (vendor && model)
    return (
      <span>
        {vendor}
        <span className="text-muted-foreground"> / {model}</span>
      </span>
    );
  if (vendor) return <span>{vendor}</span>;
  if (model) return <span>{model}</span>;
  return <span className="text-muted-foreground">—</span>;
}

function vendorModelText(
  vendor: string | null | undefined,
  model: string | null | undefined,
): string {
  if (vendor && model) return `${vendor} · ${model}`;
  return vendor ?? model ?? '—';
}

// Tiny coloured dot visible next to cp_id when the charger has a fault
// or advisory. Inline so the operator can spot fault rows by
// horizontal scan without using the filter. Hidden when ok.
function FaultDot({ level }: { level: FaultLevel }) {
  if (level === 'ok') return null;
  const cls = level === 'fault' ? 'bg-destructive' : 'bg-amber-500';
  const title =
    level === 'fault' ? 'Faulted — blocks charging' : 'Advisory — connector reports an error code';
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', cls)}
    />
  );
}

// Which gateway pod owns the charger's WebSocket. Truncated to 8 chars
// because the gateway emits the docker / k8s pod hostname (long); full
// value on hover.
function PodCell({ podId }: { podId: string | null | undefined }) {
  if (!podId) return <span className="text-muted-foreground">—</span>;
  const short = podId.length > 8 ? `${podId.slice(0, 8)}…` : podId;
  return (
    <span className="font-mono text-xs text-muted-foreground" title={podId}>
      {short}
    </span>
  );
}

function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'muted' = (() => {
    switch (status) {
      case 'Charging':
      case 'Available':
        return 'success';
      case 'Preparing':
      case 'Finishing':
      case 'Reserved':
        return 'warning';
      case 'Faulted':
        return 'destructive';
      case 'Unavailable':
        return 'muted';
      default:
        return 'secondary';
    }
  })();
  return <Badge variant={variant}>{status}</Badge>;
}

function ConnectorsSummary({ connectors }: { connectors: ChargePointSummary['connectors'] }) {
  if (connectors.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {connectors.map((c) => (
        <ConnectorDot key={c.connector_id} connector={c} />
      ))}
    </div>
  );
}

function ConnectorDot({ connector }: { connector: ChargePointSummary['connectors'][number] }) {
  const tone: 'destructive' | 'success' | 'warning' | 'info' | 'muted' = (() => {
    if (connector.error_code && connector.error_code !== 'NoError') return 'destructive';
    switch (connector.status) {
      case 'Charging':
        return 'info';
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
  })();
  const Icon =
    tone === 'destructive'
      ? CircleAlert
      : tone === 'success' || tone === 'info'
        ? CircleCheck
        : CircleDashed;
  const colour =
    tone === 'destructive'
      ? 'text-destructive'
      : tone === 'info'
        ? 'text-info'
        : tone === 'success'
          ? 'text-success'
          : tone === 'warning'
            ? 'text-amber-500'
            : 'text-muted-foreground';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
        colour,
      )}
      title={`${connector.status}${
        connector.error_code && connector.error_code !== 'NoError'
          ? ' · ' + connector.error_code
          : ''
      }`}
    >
      <Icon className="h-2.5 w-2.5" />
      <span className="font-mono">{connector.connector_id}</span>
      <span className="font-medium">{connector.status}</span>
    </span>
  );
}

function ConnectorDetail({
  connectors,
  cpId,
}: {
  connectors: ChargePointSummary['connectors'];
  cpId: string;
}) {
  if (connectors.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No connectors reported for {cpId} yet.
      </div>
    );
  }
  return (
    <div className="px-4 py-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-[10px] uppercase">connector_id</TableHead>
            <TableHead className="text-[10px] uppercase">status</TableHead>
            <TableHead className="text-[10px] uppercase">error_code</TableHead>
            <TableHead className="text-[10px] uppercase">last_changed_at</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connectors.map((c) => (
            <TableRow key={c.connector_id}>
              <TableCell className="font-mono">{c.connector_id}</TableCell>
              <TableCell>
                <StatusPill status={c.status} />
              </TableCell>
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
    </div>
  );
}

interface PaginationProps {
  pageSize: number;
  onPageSizeChange: (n: number) => void;
  page: number;
  onPageChange: (n: number) => void;
  /** Server-reported total row count under the current filter set.
   *  `null` while the first snapshot is still loading. */
  total: number | null;
  /** Server-echoed page_size from the snapshot, used to compute the
   *  pageCount + 1-based row range. Falls back to the local
   *  `pageSize` when the snapshot omits it (cursor-mode legacy). */
  serverPageSize: number | null;
  /** Rows currently rendered after the faults-only toggle. */
  loadedRowCount: number;
}

function Pagination({
  pageSize,
  onPageSizeChange,
  page,
  onPageChange,
  total,
  serverPageSize,
  loadedRowCount,
}: PaginationProps) {
  const effectivePageSize = serverPageSize ?? pageSize;
  const pageCount =
    total !== null && effectivePageSize > 0
      ? Math.max(1, Math.ceil(total / effectivePageSize))
      : null;
  const firstRow = total === 0 ? 0 : (page - 1) * effectivePageSize + 1;
  const lastRow =
    total !== null
      ? Math.min(total, (page - 1) * effectivePageSize + loadedRowCount)
      : (page - 1) * effectivePageSize + loadedRowCount;

  const canGoBack = page > 1;
  const canGoNext = pageCount !== null ? page < pageCount : loadedRowCount >= effectivePageSize;

  // Stacks vertically below `sm` so each row gets enough horizontal
  // space; horizontal at sm+ to keep the desktop layout compact.
  return (
    <div className="flex flex-col items-stretch gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center justify-between gap-2 sm:justify-start">
        <span>Rows per page</span>
        <Select
          value={String(pageSize)}
          onChange={(e) => onPageSizeChange(Number(e.currentTarget.value))}
          className="h-9 w-[80px] text-xs sm:h-7"
        >
          <option value="50">50</option>
          <option value="100">100</option>
          <option value="250">250</option>
          <option value="500">500</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
        <span>
          {total !== null ? (
            <>
              Showing{' '}
              <span className="font-medium text-foreground">{firstRow.toLocaleString()}</span>–
              <span className="font-medium text-foreground">{lastRow.toLocaleString()}</span> of{' '}
              <span className="font-medium text-foreground">{total.toLocaleString()}</span>
            </>
          ) : (
            <>
              Showing {loadedRowCount} {loadedRowCount === 1 ? 'row' : 'rows'}
            </>
          )}
          {' · Page '}
          <span className="font-medium text-foreground">{page}</span>
          {pageCount !== null ? ` of ${pageCount.toLocaleString()}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(1)}
            disabled={!canGoBack}
            className="h-9 sm:h-7"
            aria-label="First page"
          >
            « First
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={!canGoBack}
            className="h-9 sm:h-7"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={!canGoNext}
            className="h-9 sm:h-7"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          {pageCount !== null ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(pageCount)}
              disabled={page >= pageCount}
              className="h-9 sm:h-7"
              aria-label="Last page"
            >
              Last »
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-sm text-muted-foreground">
      <span>No charge points match the current filters.</span>
    </div>
  );
}
