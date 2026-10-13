// Horizontal pill row for the SystemPage service-status section.
// Replaces the old per-service Card grid; the dashboard reserves the
// vertical space above for alerts + headline numbers, so the running
// services line is intentionally compact.
//
// Sources, in render order:
//   Console  — synthetic ok pill (the page is reachable, so the
//              console server is by definition up)
//   Gateway  — sys.gateway.ok + latency_ms
//   <each gateway component> (postgres / redis / ...) from
//              sys.gateway.components — string status, "ok" is green
//   Kafka    — sys.kafka.ok + consumer_running

import { Badge } from '@/components/ui/badge';

import type { SysStatus } from '@/api/sys-client';

interface Pill {
  key: string;
  label: string;
  tone: 'success' | 'warning' | 'destructive';
  hint: string;
}

function gatewayPill(s: SysStatus): Pill {
  const g = s.gateway;
  if (!g.ok) {
    return {
      key: 'gateway',
      label: 'Gateway',
      tone: g.detail === 'status=degraded' ? 'warning' : 'destructive',
      hint: g.detail ?? 'gateway probe failed',
    };
  }
  const latency = typeof g.latency_ms === 'number' ? `${g.latency_ms} ms` : 'ok';
  return { key: 'gateway', label: 'Gateway', tone: 'success', hint: `probe ${latency}` };
}

function componentPills(s: SysStatus): Pill[] {
  const out: Pill[] = [];
  const comps = s.gateway.components ?? {};
  for (const [name, status] of Object.entries(comps)) {
    if (name.endsWith('_error_class') || typeof status !== 'string') continue;
    const ok = status === 'ok';
    out.push({
      key: `gw-${name}`,
      label: prettyComponentName(name),
      tone: ok
        ? 'success'
        : status === 'unconfigured' || status === 'unknown'
          ? 'warning'
          : 'destructive',
      hint:
        name === 'ingestor' && status === 'unknown'
          ? 'unknown — ingestion progress is not observed'
          : ok
            ? 'ok'
            : status,
    });
  }
  return out;
}

function kafkaPill(s: SysStatus): Pill {
  const k = s.kafka;
  if (!k.ok) {
    return {
      key: 'kafka',
      label: 'Kafka',
      tone: 'destructive',
      hint: k.detail ?? 'kafka unavailable',
    };
  }
  if (k.consumer_running === false) {
    return {
      key: 'kafka',
      label: 'Kafka',
      tone: 'warning',
      hint: 'consumer stopped',
    };
  }
  return { key: 'kafka', label: 'Kafka', tone: 'success', hint: 'consumer running' };
}

function prettyComponentName(name: string): string {
  if (name === 'clickhouse') return 'ClickHouse';
  // The gateway emits component keys in lowercase ("postgres", "redis").
  // Capitalising matches how the rest of the row reads ("Console",
  // "Gateway", "Kafka"). No other transformation needed.
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function buildServicePills(s: SysStatus): Pill[] {
  return [
    { key: 'console', label: 'Console', tone: 'success', hint: 'this page is up' },
    gatewayPill(s),
    ...componentPills(s),
    kafkaPill(s),
  ];
}

interface Props {
  sys: SysStatus;
}

export function ServiceStatusPills({ sys }: Props) {
  const pills = buildServicePills(sys);
  return (
    <div className="flex flex-wrap gap-2" data-testid="service-pills">
      {pills.map((p) => (
        <Badge
          key={p.key}
          variant={p.tone}
          className="gap-1.5 px-2.5 py-1 text-xs"
          title={p.hint}
          aria-label={`${p.label}: ${p.hint}`}
          data-testid={`service-pill-${p.key}`}
          data-tone={p.tone}
        >
          <span
            className={
              p.tone === 'success'
                ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                : p.tone === 'warning'
                  ? 'h-1.5 w-1.5 rounded-full bg-amber-500'
                  : 'h-1.5 w-1.5 rounded-full bg-destructive'
            }
            aria-hidden
          />
          <span className="font-medium">{p.label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{p.hint}</span>
        </Badge>
      ))}
    </div>
  );
}
