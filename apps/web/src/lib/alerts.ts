// Operator-facing "Active alerts" derivation. Pure function over the
// data the console already has on screen — the live charge-points feed
// (FleetPage's WS subscription) and the SystemPage `sys_status` poll.
//
// This is the v1 of alerting: alerts only fire while the console is
// open. There is no Prometheus, no Alertmanager, no durable on-call
// path. A future PR will plug an Alertmanager-consumer in as a second
// (additive) source so on-call paging keeps working when no operator
// is watching the page.
//
// Why client-derived for v1: zero infrastructure, ships in a day, the
// operator gets value the next time they look. The thresholds below
// are deliberately small, named constants so swapping them later is
// trivial and the choice shows up in code review.

import type { ChargePointSummary } from '@eveys-console/protocol';

import type { SysStatus } from '@/api/sys-client';

import { NO_ERROR } from './ocpp-errors';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface Alert {
  /** Stable per (kind + entity); the panel uses it as the React key
   *  so a re-render with the same condition doesn't flicker. */
  id: string;
  severity: AlertSeverity;
  /** Short, operator-readable. e.g. `cp_771a037d offline 47m`. */
  title: string;
  /** One-line context shown under the title. */
  detail: string;
  /** ISO timestamp the condition has held since, where computable.
   *  The panel renders `formatRelativeTime(since)` next to the title. */
  since?: string;
  /** When the alert is scoped to a single charger; the panel renders a
   *  link to the charger detail page if set. */
  cp_id?: string;
}

// ---- thresholds ---------------------------------------------------------
// These are the tunables. If we ever grow a server-side alert engine
// the same defaults belong there — keeping them at the top of one file
// for now so the next reader doesn't have to hunt.

/** A charger that's been silent more than this is firmly "offline-long",
 *  not "the gateway just blipped". The OCPP 1.6 default heartbeat
 *  interval is 5 min, so a real charger missing for 30 min has missed
 *  ~6 heartbeats — well past coincidence. */
export const OFFLINE_LONG_MS = 30 * 60 * 1000;

/** Gateway probe latency over this is "stale" rather than "down".
 *  The gateway's `/sys/status` probe is an in-process HTTP call; under
 *  2 s on a healthy network is normal, over is a sign the gateway is
 *  saturated or its DB connection is wedged. */
export const GATEWAY_LATENCY_STALE_MS = 2000;

/** Defensive cap on how many alerts we render. Real-world fleets won't
 *  hit this; if they do, a synthetic `alerts-truncated` info row at the
 *  end tells the operator we ran out of room. */
export const MAX_ALERTS = 50;

// ---- helpers ------------------------------------------------------------

const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function bySeverityThenTitle(a: Alert, b: Alert): number {
  const sa = SEVERITY_ORDER[a.severity];
  const sb = SEVERITY_ORDER[b.severity];
  if (sa !== sb) return sa - sb;
  if (a.title < b.title) return -1;
  if (a.title > b.title) return 1;
  return 0;
}

/** Render a millisecond duration as a compact "Xm" / "Xh Ym" / "Xd Yh"
 *  for use inside alert titles. Mirrors the shape of `formatUptime`
 *  in `lib/time.ts` but takes a delta directly so the alert helper
 *  can stay clock-injectable. */
function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

// ---- main ---------------------------------------------------------------

export interface ComputeAlertsInput {
  charge_points: ChargePointSummary[];
  sys_status: SysStatus | null | undefined;
  /** Injected for testability; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Derive operator-facing alerts from the live console data. Pure,
 * deterministic, sorted. See module header for the rule list and the
 * scope (browser-only, fires while the console is open).
 */
export function computeAlerts(input: ComputeAlertsInput): Alert[] {
  const { charge_points: cps, sys_status: sys } = input;
  const now = (input.now ?? Date.now)();
  const alerts: Alert[] = [];

  // ---- gateway / kafka transport ---------------------------------------

  const gatewayDown = !!sys && sys.gateway.ok === false;
  if (gatewayDown) {
    alerts.push({
      id: 'gateway-down',
      severity: 'critical',
      title: 'OCPP gateway down',
      detail:
        sys!.gateway.detail ??
        'The gateway probe failed; chargers cannot reach the backend right now.',
    });
  }

  if (sys && sys.kafka.ok === false) {
    alerts.push({
      id: 'kafka-down',
      severity: 'critical',
      title: 'Kafka tail down',
      detail:
        sys.kafka.detail ??
        'The Kafka consumer is not running; live events are not being mirrored.',
    });
  }

  // ---- per-charger faults ---------------------------------------------

  for (const cp of cps) {
    const faulted = cp.connectors.some(
      (c) =>
        c.status_freshness !== 'stale' &&
        c.status_freshness !== 'unknown' &&
        c.status === 'Faulted',
    );
    if (faulted) {
      alerts.push({
        id: `charger-faulted:${cp.cp_id}`,
        severity: 'critical',
        title: `${cp.cp_id} faulted`,
        detail: 'At least one connector reported Faulted; charging is blocked.',
        cp_id: cp.cp_id,
      });
    }
  }

  // ---- offline-long ---------------------------------------------------

  for (const cp of cps) {
    if (cp.online) continue;
    // Excludes chargers that were never online (no last_heartbeat_at):
    // they're not "lost", they just never connected — surfacing those
    // would drown the panel in fresh-stack noise.
    if (!cp.last_heartbeat_at) continue;
    const lastHb = new Date(cp.last_heartbeat_at).getTime();
    if (Number.isNaN(lastHb)) continue;
    const ageMs = now - lastHb;
    if (ageMs <= OFFLINE_LONG_MS) continue;
    alerts.push({
      id: `charger-offline-long:${cp.cp_id}`,
      severity: 'warning',
      title: `${cp.cp_id} offline ${formatAge(ageMs)}`,
      detail: 'No heartbeat for over 30 minutes; the charger is unreachable.',
      since: cp.last_heartbeat_at,
      cp_id: cp.cp_id,
    });
  }

  // ---- connector advisory --------------------------------------------

  for (const cp of cps) {
    for (const conn of cp.connectors) {
      if (conn.status_freshness === 'stale' || conn.status_freshness === 'unknown') continue;
      if (!conn.error_code || conn.error_code === NO_ERROR) continue;
      // If the connector is also Faulted, the charger-faulted critical
      // already covers it — we don't want one connector producing both
      // a critical and a warning row.
      if (conn.status === 'Faulted') continue;
      alerts.push({
        id: `connector-advisory:${cp.cp_id}:${conn.connector_id}`,
        severity: 'warning',
        title: `${cp.cp_id} connector ${conn.connector_id} ${conn.error_code}`,
        detail: `Status ${conn.status}; charger is reporting ${conn.error_code}.`,
        ...(conn.last_changed_at ? { since: conn.last_changed_at } : {}),
        cp_id: cp.cp_id,
      });
    }
  }

  // ---- gateway latency -----------------------------------------------

  if (
    sys &&
    sys.gateway.ok &&
    typeof sys.gateway.latency_ms === 'number' &&
    sys.gateway.latency_ms > GATEWAY_LATENCY_STALE_MS
  ) {
    alerts.push({
      id: 'gateway-stale',
      severity: 'warning',
      title: `Gateway probe slow (${sys.gateway.latency_ms} ms)`,
      detail: `Probe latency exceeded ${GATEWAY_LATENCY_STALE_MS} ms; the gateway may be saturated.`,
    });
  }

  // ---- empty fleet ---------------------------------------------------

  // Suppressed when the gateway itself is down — that alert already
  // explains why the fleet looks empty, and stacking the two would
  // just add noise.
  if (sys && sys.gateway.ok && cps.length === 0 && !gatewayDown) {
    alerts.push({
      id: 'no-charge-points',
      severity: 'info',
      title: 'No charge points connected',
      detail:
        'The gateway is healthy but no chargers are registered yet. On a fresh dev stack this is normal.',
    });
  }

  // ---- sort + truncate -----------------------------------------------

  alerts.sort(bySeverityThenTitle);

  if (alerts.length > MAX_ALERTS) {
    const truncated = alerts.slice(0, MAX_ALERTS);
    truncated.push({
      id: 'alerts-truncated',
      severity: 'info',
      title: 'More alerts not shown',
      detail: `${alerts.length - MAX_ALERTS} additional alerts were truncated to keep the panel readable.`,
    });
    return truncated;
  }

  return alerts;
}
