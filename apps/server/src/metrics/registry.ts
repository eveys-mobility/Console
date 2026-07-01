// Prometheus registry + named recorders for the Console server.
//
// One process-wide `Registry` is exported so `/metrics` can serialize it and
// individual call sites can stay tiny (`recordWsClose(4401)`). Process
// metrics keep their canonical names (`process_cpu_seconds_total`, …) so
// stock Grafana dashboards work; the `eveys_console_` prefix only applies
// to the custom collectors below.
//
// Label hygiene: every metric with labels enumerates its label set at
// construction. Anything `cp_id` / `txid` / URL-path-shaped is intentionally
// omitted — high cardinality breaks Prometheus harder than the lost
// dimension is worth.

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const PREFIX = 'eveys_console_';

export const register = new Registry();

collectDefaultMetrics({ register, prefix: PREFIX });

// ---- WS lifecycle ----------------------------------------------------------

const wsConnections = new Gauge({
  name: `${PREFIX}ws_connections`,
  help: 'Currently-open WebSocket connections.',
  registers: [register],
});

const wsMessages = new Counter({
  name: `${PREFIX}ws_messages_total`,
  help: 'WebSocket messages, by direction.',
  labelNames: ['direction'] as const,
  registers: [register],
});

const wsCloseTotal = new Counter({
  name: `${PREFIX}ws_close_total`,
  help: 'WebSocket close events, by close code.',
  labelNames: ['code'] as const,
  registers: [register],
});

// ---- Auth ------------------------------------------------------------------

const authLogin = new Counter({
  name: `${PREFIX}auth_login_total`,
  help: 'Login attempts, by outcome.',
  labelNames: ['result'] as const,
  registers: [register],
});

const authPowSolveSeconds = new Histogram({
  name: `${PREFIX}auth_pow_solve_seconds`,
  help: 'Wall time the PoW verifier spent re-hashing a submitted solution.',
  // Small buckets — verify is hash + signature compare, sub-millisecond happy
  // path; the long tail catches GC or scheduler stalls.
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

// ---- Gateway client --------------------------------------------------------

const gatewayRequestTotal = new Counter({
  name: `${PREFIX}gateway_request_total`,
  help: 'Calls to the upstream gateway REST API, by operation and status.',
  // `op` is a closed enum of method names (see GatewayOp), NOT a URL path.
  // `status` is the HTTP code or "error" if the request never landed.
  labelNames: ['op', 'status'] as const,
  registers: [register],
});

const gatewayRequestSeconds = new Histogram({
  name: `${PREFIX}gateway_request_seconds`,
  help: 'Duration of upstream gateway REST calls, by operation.',
  labelNames: ['op'] as const,
  buckets: [0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ---- Kafka tail ------------------------------------------------------------

const kafkaMessages = new Counter({
  name: `${PREFIX}kafka_messages_total`,
  help: 'Decoded Kafka events received, by topic.',
  labelNames: ['topic'] as const,
  registers: [register],
});

// ---- Recorder API ----------------------------------------------------------
//
// Thin functions over the collectors. Two reasons: callsites stay readable
// (`recordWsClose(4401)` reads like a domain action), and the impl is
// trivially swappable if a future phase moves to OTLP/StatsD without
// touching every caller.

export type WsDirection = 'in' | 'out';
export type AuthLoginResult = 'success' | 'invalid_credentials' | 'disabled';

// Enumerated up front so `gateway_request_total{op}` stays a closed set even
// as the gateway client grows. Add a new op here, and only here.
export type GatewayOp =
  | 'health'
  | 'sys_config'
  | 'sys_kpis'
  | 'admin_config'
  | 'patch_admin_config'
  | 'delete_admin_config_override'
  | 'restart_gateway'
  | 'list_charge_points'
  | 'get_charge_point'
  | 'list_active_transactions'
  | 'list_transactions'
  | 'list_charge_point_transactions'
  | 'list_charge_point_reservations'
  | 'get_transaction'
  | 'list_meter_values'
  | 'list_cp_frames'
  | 'list_transaction_frames'
  | 'get_uptime'
  | 'aggregate_transactions'
  | 'list_fleet_status_history'
  | 'command_remote_start'
  | 'command_remote_stop'
  | 'command_reset'
  | 'command_trigger_message'
  | 'command_unlock_connector'
  | 'command_clear_cache'
  | 'command_get_configuration'
  | 'command_change_configuration'
  | 'command_reserve_now'
  | 'command_cancel_reservation'
  | 'command_get_diagnostics'
  | 'command_get_log'
  | 'command_data_transfer'
  | 'list_authorizations'
  | 'approve_authorization'
  | 'reject_authorization'
  | 'revoke_authorization'
  | 'list_webhook_backlog'
  | 'get_webhook_backlog'
  | 'replay_webhook_backlog'
  | 'purge_webhook_backlog'
  | 'replay_dead_webhook_backlog'
  | 'purge_dead_webhook_backlog';

export function recordWsConnection(delta: 1 | -1): void {
  if (delta === 1) wsConnections.inc();
  else wsConnections.dec();
}

export function recordWsMessage(direction: WsDirection): void {
  wsMessages.inc({ direction });
}

export function recordWsClose(code: number): void {
  // Bucket the code as a string label so cardinality stays bounded by the
  // close-code space (RFC 6455 + our 4xxx app codes), not by anything
  // userland.
  wsCloseTotal.inc({ code: String(code) });
}

export function recordAuthLogin(result: AuthLoginResult): void {
  authLogin.inc({ result });
}

export function recordAuthPowSolve(seconds: number): void {
  authPowSolveSeconds.observe(seconds);
}

export function recordGatewayRequest(
  op: GatewayOp,
  status: number | 'error',
  seconds: number,
): void {
  gatewayRequestTotal.inc({ op, status: String(status) });
  gatewayRequestSeconds.observe({ op }, seconds);
}

export function recordKafkaMessage(topic: string): void {
  kafkaMessages.inc({ topic });
}

// Test-only escape hatch. Vitest shares the module graph across tests, so
// the registry is global — clear cumulative state between cases to keep
// counter assertions deterministic. Do NOT call this in production code.
export function resetMetricsForTests(): void {
  register.resetMetrics();
}
