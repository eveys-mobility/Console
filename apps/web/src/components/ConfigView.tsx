import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  clearGatewayAdminOverride,
  fetchConsoleAdminConfig,
  fetchGatewayAdminConfig,
  setConsoleAdminConfig,
  clearConsoleAdminOverride,
  setGatewayAdminConfig,
  type ConfigEntry,
  type ConfigScope,
  type ConsoleAdminConfig,
  type GatewayAdminConfig,
  type RestartImpact,
  type SysConfig,
} from '@/api/config-client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toaster';
import { useConsoleClient } from '@/lib/ws-context';
import { cn } from '@/lib/utils';

// Shared rendering for the Console-config and Gateway-config pages.
// The two pages differ in (1) data source — fetchConsoleConfig vs
// fetchGatewayConfig — and (2) which restart-impact filter buttons make
// sense to show. The Gateway tab additionally renders inline editors
// for keys the gateway flags as runtime-mutable (the override allowlist
// in `runtime_overrides.py`); everything else stays read-only with a
// tooltip explaining why.

export interface ConfigViewProps {
  /** What scope this view represents. Drives the page heading and the
   * "to apply a change" hint copy. */
  scope: ConfigScope;
  /** Plain title shown at the top of the page. */
  title: string;
  /** Cache key used for the underlying useQuery. */
  queryKey: string;
  /** Fetcher that returns the SysConfig response. The token comes from
   * the auth context. */
  fetcher: (token: string) => Promise<SysConfig>;
  /** Restart-impact filter buttons to render (in order). 'all' should
   * always be first. */
  filters: Array<RestartImpact | 'all'>;
}

const FILTER_LABELS: Record<RestartImpact | 'all', string> = {
  all: 'All',
  none: 'Live',
  console: 'Console',
  gateway: 'Gateway',
  both: 'Both',
};

const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;

export function ConfigView({ scope, title, queryKey, fetcher, filters }: ConfigViewProps) {
  const { token } = useConsoleClient();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [restartFilter, setRestartFilter] = useState<RestartImpact | 'all'>('all');
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const q: UseQueryResult<SysConfig> = useQuery({
    queryKey: [queryKey],
    queryFn: () => fetcher(token!),
    enabled: !!token,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [queryKey] });
    if (scope === 'gateway') {
      void qc.invalidateQueries({ queryKey: ['sys-gateway-admin-config'] });
    } else {
      void qc.invalidateQueries({ queryKey: ['sys-console-admin-config'] });
    }
  };

  // Gateway-only: pull the runtime-override allowlist + current
  // overrides. The Gateway tab needs both to render inline editors.
  // The Console tab uses its own admin query (consoleAdminQ below).
  const adminQ: UseQueryResult<GatewayAdminConfig> = useQuery({
    queryKey: ['sys-gateway-admin-config'],
    queryFn: () => fetchGatewayAdminConfig(token!),
    enabled: scope === 'gateway' && !!token,
  });

  // Console-only twin: the server returns each entry with an
  // `overridable` flag and a list of allowlisted keys. The UI uses
  // both to gate inline editors the same way the gateway tab does.
  const consoleAdminQ: UseQueryResult<ConsoleAdminConfig> = useQuery({
    queryKey: ['sys-console-admin-config'],
    queryFn: () => fetchConsoleAdminConfig(token!),
    enabled: scope === 'console' && !!token,
  });

  const entries = q.data?.entries ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (restartFilter !== 'all' && e.restart !== restartFilter) return false;
      if (sensitiveOnly && !e.sensitive) return false;
      if (!needle) return true;
      return e.key.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle);
    });
  }, [entries, search, restartFilter, sensitiveOnly]);

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading configuration…
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Configuration unavailable</AlertTitle>
        <AlertDescription>
          {q.error instanceof Error ? q.error.message : 'unknown error'}
        </AlertDescription>
      </Alert>
    );
  }

  const sensitiveKeys = entries.filter((e) => e.sensitive).map((e) => e.key);
  const sourceCopy = scope === 'gateway' ? 'gateway process' : 'Console server';
  const sensitiveCopy =
    scope === 'gateway'
      ? 'These keys carry secret material and arrive masked from the gateway. The reveal toggle unmasks the placeholder text only — the underlying secret never leaves the gateway.'
      : 'These keys carry secret material and arrive masked from the Console server. The reveal toggle unmasks the placeholder text only — the underlying secret never leaves the Console.';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-semibold">
          <Settings className="h-5 w-5" />
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          Values were loaded by the {sourceCopy} at{' '}
          <span className="font-mono">{q.data.loaded_at}</span>. To change a key, edit the relevant
          env var and restart the process indicated by its <em>restart</em> column
          {scope === 'gateway' ? ', or use the inline editor for runtime-mutable keys' : ''}.
        </p>
      </div>

      {scope === 'gateway' ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Runtime overrides are per-pod</AlertTitle>
          <AlertDescription>
            Inline edits write to the gateway's in-memory override map. They are not persisted: a
            restart, redeploy, or rolling update reverts to the env value. Cluster-wide changes
            still need an env-var update plus a gateway restart.
          </AlertDescription>
        </Alert>
      ) : null}

      {sensitiveKeys.length > 0 ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {sensitiveKeys.length} sensitive key{sensitiveKeys.length === 1 ? '' : 's'} masked
          </AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs">{sensitiveKeys.join(', ')}</span>
            <span className="mt-1 block">{sensitiveCopy}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by key or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search configuration"
          />
        </div>
        <RestartFilter value={restartFilter} onChange={setRestartFilter} options={filters} />
        <Button
          variant={sensitiveOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSensitiveOnly((v) => !v)}
          aria-pressed={sensitiveOnly}
          title="Show only the keys flagged as sensitive"
        >
          <Lock className="mr-1 h-4 w-4" /> Sensitive only
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRevealed((v) => !v)}
          aria-pressed={revealed}
        >
          {revealed ? (
            <>
              <EyeOff className="mr-1 h-4 w-4" /> Hide sensitive
            </>
          ) : (
            <>
              <Eye className="mr-1 h-4 w-4" /> Show sensitive placeholder
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={q.isFetching}
          aria-label="Refresh configuration"
          title="Re-fetch the current configuration from the server"
        >
          <RefreshCw className={cn('mr-1 h-4 w-4', q.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          No keys match the current filter.
        </p>
      ) : (
        <GroupedEntries
          entries={filtered}
          revealed={revealed}
          scope={scope}
          adminConfig={adminQ.data}
          consoleAdminConfig={consoleAdminQ.data}
          configQueryKey={queryKey}
          isFiltering={search.trim().length > 0 || restartFilter !== 'all' || sensitiveOnly}
        />
      )}
    </div>
  );
}

// Group entries by `category` and render each group as a collapsible
// section. Sorting + collapsing rules:
//
//   - Categories with at least one mutable key sort to the top
//     ("hotness" — the ones an operator actually touches). Ties
//     broken alphabetically.
//   - A category opens by default when (a) a filter is active (the
//     operator is searching), or (b) any entry in it has an active
//     override. Otherwise it starts collapsed; the operator chooses.
//   - Above the categories, a pinned "Active overrides" section
//     surfaces every key whose source === 'override' so the operator
//     sees what they've changed at a glance.
function GroupedEntries({
  entries,
  revealed,
  scope,
  adminConfig,
  consoleAdminConfig,
  configQueryKey,
  isFiltering,
}: {
  entries: ConfigEntry[];
  revealed: boolean;
  scope: ConfigScope;
  adminConfig: GatewayAdminConfig | undefined;
  consoleAdminConfig: ConsoleAdminConfig | undefined;
  configQueryKey: string;
  isFiltering: boolean;
}) {
  // Bucket by category.
  const byCategory = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    const cat = entry.category || 'other';
    const list = byCategory.get(cat);
    if (list) list.push(entry);
    else byCategory.set(cat, [entry]);
  }

  // Hotness scoring: count of mutable keys per category. Ties broken
  // alphabetically. Categories with zero mutable keys (bind-time
  // structural stuff like ws_server) fall to the bottom.
  const sortedGroups = Array.from(byCategory.entries())
    .map(([category, items]) => {
      const mutableCount = items.filter((e) => e.mutable).length;
      const overrideCount = items.filter((e) => isOverrideActive(e, scope, adminConfig)).length;
      return { category, entries: items, mutableCount, overrideCount };
    })
    .sort((a, b) => {
      if (a.mutableCount !== b.mutableCount) return b.mutableCount - a.mutableCount;
      return a.category.localeCompare(b.category);
    });

  // Active overrides — flatten across all categories, render as a
  // pinned section. Hidden when empty.
  const activeOverrides = entries.filter((e) => isOverrideActive(e, scope, adminConfig));

  return (
    <div className="space-y-4">
      {activeOverrides.length > 0 ? (
        <ActiveOverridesSection
          entries={activeOverrides}
          revealed={revealed}
          scope={scope}
          adminConfig={adminConfig}
          consoleAdminConfig={consoleAdminConfig}
          configQueryKey={configQueryKey}
        />
      ) : null}

      {sortedGroups.map((group) => (
        <CategorySection
          key={group.category}
          category={group.category}
          entries={group.entries}
          overrideCount={group.overrideCount}
          revealed={revealed}
          scope={scope}
          adminConfig={adminConfig}
          consoleAdminConfig={consoleAdminConfig}
          configQueryKey={configQueryKey}
          forceOpen={isFiltering || group.overrideCount > 0}
        />
      ))}
    </div>
  );
}

function isOverrideActive(
  entry: ConfigEntry,
  scope: ConfigScope,
  adminConfig: GatewayAdminConfig | undefined,
): boolean {
  if (scope === 'console') return entry.source === 'override';
  const overrides = adminConfig?.overrides;
  return !!overrides && Object.prototype.hasOwnProperty.call(overrides, entry.key);
}

function CategorySection({
  category,
  entries,
  overrideCount,
  revealed,
  scope,
  adminConfig,
  consoleAdminConfig,
  configQueryKey,
  forceOpen,
}: {
  category: string;
  entries: ConfigEntry[];
  overrideCount: number;
  revealed: boolean;
  scope: ConfigScope;
  adminConfig: GatewayAdminConfig | undefined;
  consoleAdminConfig: ConsoleAdminConfig | undefined;
  configQueryKey: string;
  forceOpen: boolean;
}) {
  // <details> handles the open/close natively + a11y. `open` flips
  // forceOpen so the operator can still toggle once it's open.
  return (
    <details
      className="rounded-md border bg-card/40"
      open={forceOpen}
      data-testid={`config-category-${category}`}
      data-category={category}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm font-medium">
        <span>{humanizeCategory(category)}</span>
        <Badge variant="secondary" className="text-[10px]">
          {entries.length}
        </Badge>
        {overrideCount > 0 ? (
          <Badge variant="warning" className="text-[10px]" data-testid="category-override-count">
            {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </Badge>
        ) : null}
      </summary>
      <div className="grid grid-cols-1 gap-3 border-t bg-background p-3">
        {entries.map((entry) => (
          <ConfigCard
            key={entry.key}
            entry={entry}
            revealed={revealed}
            scope={scope}
            adminConfig={adminConfig}
            consoleAdminConfig={consoleAdminConfig}
            configQueryKey={configQueryKey}
          />
        ))}
      </div>
    </details>
  );
}

function ActiveOverridesSection({
  entries,
  revealed,
  scope,
  adminConfig,
  consoleAdminConfig,
  configQueryKey,
}: {
  entries: ConfigEntry[];
  revealed: boolean;
  scope: ConfigScope;
  adminConfig: GatewayAdminConfig | undefined;
  consoleAdminConfig: ConsoleAdminConfig | undefined;
  configQueryKey: string;
}) {
  return (
    <section
      aria-labelledby="config-active-overrides"
      data-testid="config-active-overrides"
      className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <h3
        id="config-active-overrides"
        className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300"
      >
        Active overrides ({entries.length})
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Runtime overrides currently in effect. Use the &quot;Reset to env&quot; button on each row
        to revert.
      </p>
      <div className="grid grid-cols-1 gap-3">
        {entries.map((entry) => (
          <ConfigCard
            key={`override-${entry.key}`}
            entry={entry}
            revealed={revealed}
            scope={scope}
            adminConfig={adminConfig}
            consoleAdminConfig={consoleAdminConfig}
            configQueryKey={configQueryKey}
          />
        ))}
      </div>
    </section>
  );
}

// Cosmetic-only: turn snake_case category names into Title Case for
// the group heading. Underscores → spaces. Words that are well-known
// acronyms render in their canonical casing instead of plain Title
// Case ("WS" not "Ws"; "gRPC" not "Grpc"; "ClickHouse" not "Clickhouse").
const ACRONYMS: Record<string, string> = {
  ws: 'WS',
  websocket: 'WebSocket',
  grpc: 'gRPC',
  rest: 'REST',
  ocpp: 'OCPP',
  clickhouse: 'ClickHouse',
  jwt: 'JWT',
  ttl: 'TTL',
  url: 'URL',
  pod: 'Pod',
  tls: 'TLS',
  otlp: 'OTLP',
  dsn: 'DSN',
  api: 'API',
  http: 'HTTP',
  ip: 'IP',
};

function humanizeCategory(raw: string): string {
  if (!raw) return 'Other';
  return raw
    .split('_')
    .map((word) => {
      if (word.length === 0) return word;
      const lower = word.toLowerCase();
      return ACRONYMS[lower] ?? word[0]!.toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function ConfigCard({
  entry,
  revealed,
  scope,
  adminConfig,
  consoleAdminConfig,
  configQueryKey,
}: {
  entry: ConfigEntry;
  revealed: boolean;
  scope: ConfigScope;
  adminConfig: GatewayAdminConfig | undefined;
  consoleAdminConfig: ConsoleAdminConfig | undefined;
  configQueryKey: string;
}) {
  // Gateway side: allowlist is a map of key → description.
  // Console side: server flags each entry directly with `overridable`.
  const gatewayAllowlist = adminConfig?.allowlist;
  const gatewayOverrides = adminConfig?.overrides;
  const isGatewayAllowlisted =
    scope === 'gateway' &&
    !!gatewayAllowlist &&
    Object.prototype.hasOwnProperty.call(gatewayAllowlist, entry.key);
  const isConsoleOverridable = scope === 'console' && !!entry.overridable;
  const isAllowlisted = isGatewayAllowlisted || isConsoleOverridable;
  const allowlistDescription = isGatewayAllowlisted
    ? gatewayAllowlist![entry.key]
    : entry.description;
  const hasOverride =
    (isGatewayAllowlisted &&
      !!gatewayOverrides &&
      Object.prototype.hasOwnProperty.call(gatewayOverrides, entry.key)) ||
    (isConsoleOverridable && entry.source === 'override');
  // Avoid unused-variable warnings when one of the admin-data sources
  // is irrelevant for the current scope.
  void consoleAdminConfig;

  // The gateway's /sys/config endpoint reports `getattr(settings, name)`,
  // which is the env-driven value and does NOT consult the runtime-override
  // singleton. So on the Gateway tab an allowlisted key with an active
  // override arrives as "" (env unset) with the `override` badge lit but
  // no value to show. Merge the override from /admin/config.overrides here
  // so the display and the editor pre-fill both reflect what the gateway
  // is actually using.
  const effectiveEntry =
    hasOverride && isGatewayAllowlisted && gatewayOverrides
      ? { ...entry, value: stringifyOverride(gatewayOverrides[entry.key]) }
      : entry;
  const display =
    effectiveEntry.sensitive && effectiveEntry.value
      ? revealed
        ? effectiveEntry.value
        : '•'.repeat(8)
      : effectiveEntry.value || '<empty>';

  // Editable rows stay open by default — the operator's intent is to
  // see the form. Read-only rows collapse so 111 entries don't form a
  // wall of text; the operator expands the row they want to inspect.
  // Active overrides always open regardless (visible state matters).
  const detailsOpen = isAllowlisted || hasOverride;

  return (
    <Card data-testid={`config-card-${entry.key}`}>
      <details open={detailsOpen} className="group/details">
        <summary
          className={cn(
            'flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5',
            // Make the summary look like the previous CardHeader so
            // the redesign feels familiar.
            'border-b border-transparent group-open/details:border-border',
          )}
        >
          <span className="flex-1 truncate font-mono text-sm font-semibold">{entry.key}</span>
          <code
            className={cn(
              'truncate rounded bg-muted px-2 py-0.5 font-mono text-[11px]',
              entry.sensitive && !revealed ? 'text-muted-foreground' : '',
            )}
            data-testid={`value-${entry.key}`}
            title={display}
          >
            {truncateForHeader(display)}
          </code>
          <div className="flex flex-wrap items-center gap-1.5">
            <SourcePill source={entry.source} />
            <RestartPill restart={entry.restart} />
            {hasOverride ? (
              <Badge variant="warning" className="text-[10px]">
                override
              </Badge>
            ) : null}
            {entry.sensitive ? <Badge variant="destructive">sensitive</Badge> : null}
            {!entry.mutable ? <Badge variant="secondary">read-only</Badge> : null}
          </div>
        </summary>
        <CardContent className="space-y-2 pt-3 text-sm">
          <p className="text-muted-foreground">{entry.description}</p>
          {entry.impact ? (
            <p className="rounded border-l-2 border-muted bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-semibold uppercase tracking-wider">Impact</span> ·{' '}
              {entry.impact}
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <KV label="Default">
              <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {entry.default || '<none>'}
              </code>
            </KV>
            <KV label="Range">
              <span className="text-xs text-muted-foreground">{entry.range}</span>
            </KV>
          </div>

          {isAllowlisted ? (
            <InlineEditor
              entry={effectiveEntry}
              description={allowlistDescription ?? entry.description}
              hasOverride={hasOverride}
              scope={scope}
              configQueryKey={configQueryKey}
            />
          ) : scope === 'gateway' ? (
            <ReadOnlyTooltip />
          ) : null}
        </CardContent>
      </details>
    </Card>
  );
}

/** Cap the value preview shown in the collapsed row so a long URL
 *  doesn't push the badges off-screen. The full value is still in the
 *  details body + the title attribute. */
function truncateForHeader(s: string): string {
  if (s.length <= 32) return s;
  return `${s.slice(0, 24)}…${s.slice(-6)}`;
}

/** Match the gateway's `_stringify` shape so a merged-in override value
 *  renders identically to the env-driven value it replaces. Booleans
 *  become "true"/"false"; lists become CSV; everything else String()s. */
function stringifyOverride(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',');
  if (typeof v === 'string') return v;
  return String(v);
}

// Lock-with-tooltip block shown next to read-only gateway keys. The
// tooltip explains the operator's recourse without sending them on a
// hunt for the runtime_overrides.py file.
function ReadOnlyTooltip() {
  return (
    <div className="flex items-center gap-2 pt-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        aria-label="Not runtime-editable"
        title="Not runtime-editable. To change this key the gateway team must add it to the override allowlist (runtime_overrides.py)."
        className="cursor-not-allowed"
      >
        <Lock className="mr-1 h-3 w-3" /> Read-only
      </Button>
      <span className="text-xs text-muted-foreground">
        Not runtime-editable. To change this key the gateway team must add it to the override
        allowlist.
      </span>
    </div>
  );
}

// Per-key inline editor. Three shapes:
//   - boolean → toggle button gated by an AlertDialog confirmation
//   - log_level → enum select with explicit Save
//   - URL / string → text input with HTML5 url validation + Save
// A "Reset to env" button appears whenever the key has an active
// override, and fires the DELETE endpoint.
function InlineEditor({
  entry,
  description,
  hasOverride,
  scope,
  configQueryKey,
}: {
  entry: ConfigEntry;
  description: string;
  hasOverride: boolean;
  scope: ConfigScope;
  configQueryKey: string;
}) {
  const editorKind = inferEditorKind(entry);
  if (editorKind === 'bool') {
    return (
      <BoolEditor
        entry={entry}
        description={description}
        hasOverride={hasOverride}
        scope={scope}
        configQueryKey={configQueryKey}
      />
    );
  }
  if (editorKind === 'enum') {
    return (
      <EnumEditor
        entry={entry}
        options={LOG_LEVELS as unknown as string[]}
        hasOverride={hasOverride}
        scope={scope}
        configQueryKey={configQueryKey}
      />
    );
  }
  return (
    <UrlEditor
      entry={entry}
      hasOverride={hasOverride}
      scope={scope}
      configQueryKey={configQueryKey}
      isUrl={editorKind === 'url'}
    />
  );
}

type EditorKind = 'bool' | 'enum' | 'url' | 'text';

function inferEditorKind(entry: ConfigEntry): EditorKind {
  if (entry.key === 'log_level') return 'enum';
  if (entry.key.startsWith('webhook_enable_')) return 'bool';
  if (entry.key === 'ws_rate_limit_enabled') return 'bool';
  if (entry.key === 'backend_authorize_cache_enabled') return 'bool';
  if (entry.key === 'webhook_base_url') return 'url';
  if (entry.key.startsWith('webhook_url_')) return 'url';
  // Heuristic fallback for unknown keys based on the rendered value.
  const value = entry.value.toLowerCase();
  if (value === 'true' || value === 'false') return 'bool';
  if (value.startsWith('http://') || value.startsWith('https://')) return 'url';
  return 'text';
}

// Common refetch-after-mutate side-effect. Invalidates both the per-tab
// config (so the rendered value updates) and the matching admin-config
// (so the override badge / reset button reflect truth on the right tab).
function useRefetchConfig(configQueryKey: string, scope: ConfigScope) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [configQueryKey] });
    if (scope === 'gateway') {
      void qc.invalidateQueries({ queryKey: ['sys-gateway-admin-config'] });
    } else {
      void qc.invalidateQueries({ queryKey: ['sys-console-admin-config'] });
    }
  };
}

function useApplyOverride(configQueryKey: string, scope: ConfigScope) {
  const { token } = useConsoleClient();
  const { toast } = useToast();
  const refetch = useRefetchConfig(configQueryKey, scope);

  return useMutation<unknown, Error, { key: string; value: unknown }>({
    mutationFn: ({ key, value }) =>
      scope === 'gateway'
        ? setGatewayAdminConfig(token!, { [key]: value })
        : setConsoleAdminConfig(token!, key, value),
    onSuccess: (_data, vars) => {
      toast({
        title: 'Override applied',
        description:
          scope === 'gateway'
            ? `Set ${vars.key} to ${formatValue(vars.value)} (per-pod). Restart reverts to env.`
            : `Set ${vars.key} to ${formatValue(vars.value)}. Persisted; survives Console restart.`,
      });
      refetch();
    },
    onError: (err: unknown, vars) => {
      toast({
        variant: 'destructive',
        title: `Couldn't update ${vars.key}`,
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });
}

function useClearOverride(configQueryKey: string, scope: ConfigScope) {
  const { token } = useConsoleClient();
  const { toast } = useToast();
  const refetch = useRefetchConfig(configQueryKey, scope);

  return useMutation<unknown, Error, { key: string }>({
    mutationFn: ({ key }) =>
      scope === 'gateway'
        ? clearGatewayAdminOverride(token!, key)
        : clearConsoleAdminOverride(token!, key),
    onSuccess: (_data, vars) => {
      toast({
        title: 'Override cleared',
        description: `${vars.key} reverted to env value.`,
      });
      refetch();
    },
    onError: (err: unknown, vars) => {
      toast({
        variant: 'destructive',
        title: `Couldn't reset ${vars.key}`,
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    },
  });
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.length === 0 ? '<empty>' : v;
  return JSON.stringify(v);
}

function BoolEditor({
  entry,
  description,
  hasOverride,
  scope,
  configQueryKey,
}: {
  entry: ConfigEntry;
  description: string;
  hasOverride: boolean;
  scope: ConfigScope;
  configQueryKey: string;
}) {
  const current = entry.value.toLowerCase() === 'true';
  const apply = useApplyOverride(configQueryKey, scope);
  const reset = useClearOverride(configQueryKey, scope);
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const open = pendingValue !== null;
  const target = pendingValue ?? !current;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        type="button"
        variant={current ? 'default' : 'outline'}
        size="sm"
        aria-pressed={current}
        aria-label={`Toggle ${entry.key}`}
        disabled={apply.isPending || reset.isPending}
        onClick={() => setPendingValue(!current)}
      >
        {current ? 'Enabled' : 'Disabled'}
      </Button>
      <span className="text-xs text-muted-foreground">
        Click to set to <span className="font-mono">{(!current).toString()}</span>
      </span>
      {hasOverride ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => reset.mutate({ key: entry.key })}
          disabled={reset.isPending}
          aria-label={`Reset ${entry.key} to env`}
        >
          {reset.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 h-3 w-3" />
          )}
          Reset to env
        </Button>
      ) : null}

      <AlertDialog open={open} onOpenChange={(o) => !o && setPendingValue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Set <span className="font-mono">{entry.key}</span> to{' '}
              <span className="font-mono">{target.toString()}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                This change is per-pod and not persisted. A restart reverts to the env value (
                <span className="font-mono">{entry.default || '<unset>'}</span>).
              </span>
              <span className="mt-2 block">
                <span className="font-semibold">Affects:</span> {description}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingValue(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                apply.mutate({ key: entry.key, value: target });
                setPendingValue(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EnumEditor({
  entry,
  options,
  hasOverride,
  scope,
  configQueryKey,
}: {
  entry: ConfigEntry;
  options: string[];
  hasOverride: boolean;
  scope: ConfigScope;
  configQueryKey: string;
}) {
  const [value, setValue] = useState(entry.value);
  useEffect(() => {
    setValue(entry.value);
  }, [entry.value]);
  const apply = useApplyOverride(configQueryKey, scope);
  const reset = useClearOverride(configQueryKey, scope);
  const dirty = value !== entry.value;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    apply.mutate({ key: entry.key, value });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 pt-1">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">Edit</span>
        <Select
          aria-label={`Edit ${entry.key}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </Select>
      </label>
      <Button type="submit" size="sm" disabled={!dirty || apply.isPending}>
        {apply.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Save className="mr-1 h-3 w-3" />
        )}
        Save
      </Button>
      {hasOverride ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => reset.mutate({ key: entry.key })}
          disabled={reset.isPending}
          aria-label={`Reset ${entry.key} to env`}
        >
          {reset.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 h-3 w-3" />
          )}
          Reset to env
        </Button>
      ) : null}
    </form>
  );
}

function UrlEditor({
  entry,
  hasOverride,
  scope,
  configQueryKey,
  isUrl,
}: {
  entry: ConfigEntry;
  hasOverride: boolean;
  scope: ConfigScope;
  configQueryKey: string;
  isUrl: boolean;
}) {
  const [value, setValue] = useState(entry.value);
  useEffect(() => {
    setValue(entry.value);
  }, [entry.value]);
  const apply = useApplyOverride(configQueryKey, scope);
  const reset = useClearOverride(configQueryKey, scope);
  const dirty = value !== entry.value;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    apply.mutate({ key: entry.key, value });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2 pt-1">
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">Edit</span>
        <Input
          type={isUrl ? 'url' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={`Edit ${entry.key}`}
          placeholder={isUrl ? 'https://…' : ''}
          className="font-mono"
        />
      </label>
      <Button type="submit" size="sm" disabled={!dirty || apply.isPending}>
        {apply.isPending ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Save className="mr-1 h-3 w-3" />
        )}
        Save
      </Button>
      {hasOverride ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => reset.mutate({ key: entry.key })}
          disabled={reset.isPending}
          aria-label={`Reset ${entry.key} to env`}
        >
          {reset.isPending ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 h-3 w-3" />
          )}
          Reset to env
        </Button>
      ) : null}
    </form>
  );
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function SourcePill({ source }: { source: ConfigEntry['source'] }) {
  const variant = source === 'env' ? 'success' : 'secondary';
  return (
    <Badge variant={variant} className="text-[10px]">
      {source}
    </Badge>
  );
}

function RestartPill({ restart }: { restart: RestartImpact }) {
  if (restart === 'none') {
    return (
      <Badge variant="secondary" className="text-[10px]">
        live
      </Badge>
    );
  }
  const tone = restart === 'both' ? 'destructive' : 'warning';
  const label =
    restart === 'console'
      ? 'restart: Console'
      : restart === 'gateway'
        ? 'restart: gateway'
        : 'restart: Console + gateway';
  return (
    <Badge variant={tone} className="text-[10px]">
      {label}
    </Badge>
  );
}

function RestartFilter({
  value,
  onChange,
  options,
}: {
  value: RestartImpact | 'all';
  onChange: (v: RestartImpact | 'all') => void;
  options: Array<RestartImpact | 'all'>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="Filter by restart impact"
    >
      {options.map((opt) => (
        <Button
          key={opt}
          variant={value === opt ? 'default' : 'outline'}
          size="sm"
          onClick={() => onChange(opt)}
          aria-pressed={value === opt}
        >
          {FILTER_LABELS[opt]}
        </Button>
      ))}
    </div>
  );
}
