// Per-named-query resolvers. Each one knows:
//   - how to fetch the snapshot from the gateway
//   - which Kafka events affect a subscription with given params
//   - how to render an event into deltas the client can apply
//
// New named queries are added here; the protocol package's enum and
// snapshotForQuery / deltaForQuery shapes are updated in lockstep.
//
// Wire format note: Kafka payloads coming in are protobuf-decoded via
// `protobufjs`, which produces camelCase field names from the
// snake_case .proto source. So the inner payload keys here are
// `transactionId`, `connectorId`, `chargerReportedAt`, etc. The
// protocol's wire shape is snake_case, so each resolver maps between
// the two.

import type {
  ChargePointSummary,
  DeltaForQuery,
  DeviceEvent,
  MeterSample,
  QueryName,
  QueryParams,
  SnapshotForQuery,
  StatusEvent,
} from '@eveys-console/protocol';

import type { GatewayClient } from '../rest/gateway-client.js';
import type { KafkaEvent } from '../kafka/tail.js';
import { deviceEventFromKafka } from '../event-log/from-kafka.js';
import { tailLastN } from '../event-log/tail.js';
import type { Delta, Snapshot } from './types.js';

// Module-level injection for the device-events resolver. Set once at
// boot from main.ts; tests override per-suite. Keeps the
// QueryResolver signature unchanged while still letting the
// resolver read from the durable log on bootstrap.
let eventLogRoot: string | null = null;
let bootstrapLimit = 200;

export function configureEventLogReader(opts: { root: string; bootstrapLimit: number }): void {
  eventLogRoot = opts.root;
  bootstrapLimit = opts.bootstrapLimit;
}

export function resetEventLogReader(): void {
  eventLogRoot = null;
  bootstrapLimit = 200;
}

interface QueryResolver {
  snapshot(params: QueryParams, gateway: GatewayClient): Promise<Snapshot>;
  // Returns zero, one, or many deltas. A single Kafka event can fan
  // out (one MeterValues report with N samples → N appends), or be
  // filtered out entirely by params, or trigger a re-fetch
  // (cp.boot/cp.status → re-read GET /charge-points/:cp_id from the
  // gateway).
  deltasFromEvent(params: QueryParams, event: KafkaEvent, gateway: GatewayClient): Promise<Delta[]>;
}

const chargePoints: QueryResolver = {
  async snapshot(params, gateway) {
    const filter: {
      online?: boolean;
      vendor?: string;
      ocpp_version?: string;
      last_status?: string;
      cp_id_prefix?: string;
      cp_id_contains?: string;
      limit?: number;
      cursor?: string;
      page?: number;
      page_size?: number;
    } = {};
    if (typeof params.online === 'boolean') filter.online = params.online;
    if (typeof params.vendor === 'string') filter.vendor = params.vendor;
    if (typeof params.ocpp_version === 'string') filter.ocpp_version = params.ocpp_version;
    if (typeof params.last_status === 'string') filter.last_status = params.last_status;
    if (typeof params.cp_id_prefix === 'string') filter.cp_id_prefix = params.cp_id_prefix;
    if (typeof params.cp_id_contains === 'string') filter.cp_id_contains = params.cp_id_contains;
    if (typeof params.limit === 'number') filter.limit = params.limit;
    if (typeof params.cursor === 'string') filter.cursor = params.cursor;
    if (typeof params.page === 'number') filter.page = params.page;
    if (typeof params.page_size === 'number') filter.page_size = params.page_size;
    // The gateway returns a `pagination` block in page-mode and a
    // `next_cursor` field in cursor-mode (never both). Surface both
    // to the UI so the same snapshot kind backs either flow.
    const data = (await gateway.listChargePoints(filter)) as {
      charge_points: ChargePointSummary[];
      next_cursor?: string | null;
      pagination?: { page?: number; page_size?: number; total?: number };
    };
    const cursor = `gw:cp-list:${Date.now()}`;
    const snapshot: SnapshotForQuery = {
      kind: 'charge-points',
      rows: data.charge_points,
      next_cursor: data.next_cursor ?? null,
    };
    if (data.pagination) {
      if (typeof data.pagination.page === 'number') snapshot.page = data.pagination.page;
      if (typeof data.pagination.page_size === 'number') {
        snapshot.page_size = data.pagination.page_size;
      }
      if (typeof data.pagination.total === 'number') snapshot.total = data.pagination.total;
    }
    return { cursor, snapshot };
  },
  async deltasFromEvent(params, event, gateway) {
    // Topics we re-fetch the row for:
    //   - cp.boot         → vendor/model/fw might've changed
    //   - cp.status       → connector state changed
    //   - cp.connected    → charger came online (online flag flips)
    //   - cp.disconnected → charger went away  (online flag flips)
    // Without the two presence topics the `online` column in the
    // list view only updates when a status/boot event happens to
    // come through next — which can be never if a charger drops
    // off and stays off.
    if (
      event.topic !== 'cp.boot' &&
      event.topic !== 'cp.status' &&
      event.topic !== 'cp.connected' &&
      event.topic !== 'cp.disconnected'
    )
      return [];
    if (!event.cpId) return [];

    // The Kafka event payload only carries a small subset of the
    // ChargePointSummary fields. Re-fetch the full row from the
    // gateway so the UI can merge a complete record. Cost: one HTTP
    // call per event. Acceptable while load is low; a future commit
    // will replace this with an in-memory snapshot store fed by the
    // same Kafka tail.
    let row: ChargePointSummary;
    try {
      row = (await gateway.getChargePoint(event.cpId)) as ChargePointSummary;
    } catch {
      return [];
    }

    // The gateway sources `connectors[]` from ClickHouse (`cp_status`),
    // which the ingestor fills in batches. Right after a charger emits
    // a StatusNotification the ingestor hasn't necessarily flushed
    // yet, so the re-fetch can come back with stale (or empty) per-
    // connector state. Patch the just-arrived event into the row so
    // the UI shows the fresh value immediately; the next refetch will
    // confirm it once ClickHouse catches up.
    if (event.topic === 'cp.status') {
      row = mergeConnectorFromStatusEvent(row, event);
    }

    if (typeof params.online === 'boolean' && row.online !== params.online) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    if (typeof params.vendor === 'string' && row.vendor !== params.vendor) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    if (typeof params.ocpp_version === 'string' && row.ocpp_version !== params.ocpp_version) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    if (typeof params.last_status === 'string' && row.last_status !== params.last_status) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    if (
      typeof params.cp_id_prefix === 'string' &&
      params.cp_id_prefix.length > 0 &&
      !row.cp_id.startsWith(params.cp_id_prefix)
    ) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    if (
      typeof params.cp_id_contains === 'string' &&
      params.cp_id_contains.length > 0 &&
      !row.cp_id.toLowerCase().includes(params.cp_id_contains.toLowerCase())
    ) {
      return [
        {
          cursor: event.cursor,
          delta: { kind: 'charge-points', op: 'remove', cp_id: row.cp_id },
        },
      ];
    }
    return [
      {
        cursor: event.cursor,
        delta: { kind: 'charge-points', op: 'upsert', row },
      },
    ];
  },
};

// Apply a cp.status event's per-connector payload to the row so the
// UI doesn't have to wait for the gateway's ClickHouse-backed
// connectors[] to catch up. Idempotent: if the row already carries a
// newer entry for the same connector, the event is dropped.
function mergeConnectorFromStatusEvent(
  row: ChargePointSummary,
  event: KafkaEvent,
): ChargePointSummary {
  const p = event.payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return row;
  const connectorId = Number(p.connectorId ?? NaN);
  if (!Number.isFinite(connectorId)) return row;
  const status = typeof p.status === 'string' ? p.status : null;
  if (!status) return row;
  const reportedAt =
    typeof p.chargerReportedAt === 'string' && p.chargerReportedAt
      ? p.chargerReportedAt
      : event.timestamp.toISOString();
  const errorCode = typeof p.errorCode === 'string' && p.errorCode !== '' ? p.errorCode : null;

  const existing = row.connectors.find((c) => c.connector_id === connectorId);
  if (existing && existing.last_changed_at && existing.last_changed_at >= reportedAt) {
    return row;
  }
  const next = row.connectors.filter((c) => c.connector_id !== connectorId);
  next.push({
    connector_id: connectorId,
    status,
    error_code: errorCode,
    last_changed_at: reportedAt,
  });
  next.sort((a, b) => a.connector_id - b.connector_id);
  return { ...row, connectors: next };
}

const chargePoint: QueryResolver = {
  async snapshot(params, gateway) {
    const cpId = stringParam(params, 'cp_id');
    const data = (await gateway.getChargePoint(cpId)) as ChargePointSummary;
    const cursor = `gw:cp:${cpId}:${Date.now()}`;
    return { cursor, snapshot: { kind: 'charge-point', row: data } };
  },
  async deltasFromEvent(params, event, gateway) {
    const cpId = stringParam(params, 'cp_id');
    if (event.cpId !== cpId) return [];
    // Mirror the list resolver: react to status/boot edits AND to
    // presence transitions so the detail page's "online" header
    // flips immediately when a charger appears or drops. Diagnostics
    // + firmware status flips also map here — the row's
    // `last_diagnostics_status` / `last_firmware_status` chips are
    // dead air without these topics (the gateway records the new
    // value but the Console never knew to re-fetch).
    if (
      event.topic !== 'cp.boot' &&
      event.topic !== 'cp.status' &&
      event.topic !== 'cp.connected' &&
      event.topic !== 'cp.disconnected' &&
      event.topic !== 'cp.diagnostics_status' &&
      event.topic !== 'cp.firmware_status'
    )
      return [];

    // Same approach as the list resolver: re-fetch the full row from
    // the gateway so the UI gets a complete update. This page is one
    // charger so the cost is bounded.
    let row: ChargePointSummary;
    try {
      row = (await gateway.getChargePoint(cpId)) as ChargePointSummary;
    } catch {
      return [];
    }
    const delta: DeltaForQuery = { kind: 'charge-point', row };
    return [{ cursor: event.cursor, delta }];
  },
};

const transactionsActive: QueryResolver = {
  async snapshot(_params, gateway) {
    const data = (await gateway.listActiveTransactions()) as { transactions: unknown[] };
    const cursor = `gw:tx-active:${Date.now()}`;
    return {
      cursor,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      snapshot: { kind: 'transactions-active', rows: data.transactions as any[] },
    };
  },
  async deltasFromEvent(_params, event) {
    if (event.topic !== 'tx.started') return [];
    const p = event.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return [];
    // The wire shape mirrors the gateway's GET /api/v1/transactions row.
    // For a delta from a tx.started event we only have a subset; the
    // missing fields (stopped_*, consumed_wh) are null because the
    // session is still open.
    const row = {
      transaction_id: Number(p.transactionId ?? 0),
      cp_id: event.cpId ?? '',
      connector_id: Number(p.connectorId ?? 0),
      id_tag: String(p.idTag ?? ''),
      meter_start_wh: Number(p.meterStartWh ?? 0),
      meter_stop_wh: null,
      consumed_wh: null,
      started_reported_at: String(p.chargerReportedAt ?? event.timestamp.toISOString()),
      started_received_at: event.timestamp.toISOString(),
      stopped_reported_at: null,
      stopped_received_at: null,
      stop_reason: null,
    };
    return [
      {
        cursor: event.cursor,
        delta: { kind: 'transactions-active', op: 'upsert', row },
      },
    ];
  },
};

const meterHistory: QueryResolver = {
  async snapshot() {
    // v1: snapshot is empty; meter history grows from the live tail.
    // Phase 2: back this with a ClickHouse-fed paginated read.
    return {
      cursor: `gw:meter:bootstrap:${Date.now()}`,
      snapshot: { kind: 'meter-history', rows: [] },
    };
  },
  async deltasFromEvent(params, event) {
    if (event.topic !== 'cp.meter') return [];
    const cpId = stringParam(params, 'cp_id');
    if (event.cpId !== cpId) return [];

    // CpMeter payload (camelCase): connectorId, transactionId,
    // sampledValues[], chargerReportedAt. One OCPP MeterValues report
    // can carry many sampled values; emit one delta per value so each
    // is independently appendable to the UI's chart.
    const p = event.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return [];
    const samplesRaw = p.sampledValues;
    const samples = Array.isArray(samplesRaw) ? samplesRaw : [];
    if (samples.length === 0) return [];

    const connectorId = Number(p.connectorId ?? 0);
    const transactionId = p.transactionId != null ? Number(p.transactionId) : null;
    const recordedAt = String(p.chargerReportedAt ?? event.timestamp.toISOString());
    const sourceCpId = event.cpId ?? cpId;

    const out: Delta[] = [];
    for (const sv of samples) {
      if (!sv || typeof sv !== 'object') continue;
      const s = sv as Record<string, unknown>;
      const valueRaw = s.value;
      if (valueRaw == null) continue;
      const value = typeof valueRaw === 'number' ? valueRaw : Number(valueRaw);
      if (!Number.isFinite(value)) continue;

      const sample: MeterSample = {
        cp_id: sourceCpId,
        transaction_id: transactionId,
        connector_id: connectorId,
        measurand: enumToString(s.measurand) ?? 'Energy.Active.Import.Register',
        phase: enumToString(s.phase),
        value,
        unit: enumToString(s.unit),
        recorded_at: recordedAt,
      };
      out.push({
        cursor: event.cursor,
        delta: { kind: 'meter-history', append: sample },
      });
    }
    return out;
  },
};

const statusHistory: QueryResolver = {
  async snapshot() {
    return {
      cursor: `gw:status:bootstrap:${Date.now()}`,
      snapshot: { kind: 'status-history', rows: [] },
    };
  },
  async deltasFromEvent(params, event) {
    if (event.topic !== 'cp.status') return [];
    const cpId = stringParam(params, 'cp_id');
    if (event.cpId !== cpId) return [];

    // CpStatus payload (camelCase): connectorId, status, errorCode,
    // info, vendorId, vendorErrorCode, chargerReportedAt.
    const p = event.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return [];

    const sample: StatusEvent = {
      cp_id: event.cpId ?? cpId,
      connector_id: Number(p.connectorId ?? 0),
      status: String(p.status ?? ''),
      error_code: nullableString(p.errorCode),
      info: nullableString(p.info),
      reported_at: String(p.chargerReportedAt ?? event.timestamp.toISOString()),
    };
    return [
      {
        cursor: event.cursor,
        delta: { kind: 'status-history', append: sample },
      },
    ];
  },
};

// Per-charger event stream. Listens to all four topics and renders
// each into a `DeviceEvent` row for the charger detail page's live
// feed. `cp.meter` is collapsed to one summary row per MeterValues
// report rather than fanning out per sample — the per-sample chart
// has its own resolver, this feed is for navigation.
const deviceEvents: QueryResolver = {
  async snapshot(params) {
    // Bootstrap from the durable log so the panel shows the most
    // recent events the moment the page opens — rather than waiting
    // for whatever happens to fire after the subscribe. Newest
    // first; ascending in the panel is the UI's choice. Falls back
    // to an empty snapshot when the log isn't configured (tests
    // that don't need history) or the CP has no recorded events
    // yet.
    let rows: DeviceEvent[] = [];
    const cpIdRaw = params.cp_id;
    if (eventLogRoot && typeof cpIdRaw === 'string' && cpIdRaw.length > 0) {
      try {
        rows = await tailLastN(eventLogRoot, cpIdRaw, { limit: bootstrapLimit });
      } catch {
        rows = [];
      }
    }
    return {
      cursor: `gw:device-events:bootstrap:${Date.now()}`,
      snapshot: { kind: 'device-events', rows },
    };
  },
  async deltasFromEvent(params, event) {
    const cpId = stringParam(params, 'cp_id');
    if (event.cpId !== cpId) return [];
    // Delegate to the shared mapper so the live tail and the durable
    // disk log can't drift. Any topic the mapper doesn't recognise
    // (e.g. tx.started's status-history pair, cp.meter sample fan-out)
    // returns null and we emit no delta.
    const mapped = deviceEventFromKafka(event);
    if (!mapped) return [];
    return [{ cursor: event.cursor, delta: { kind: 'device-events', append: mapped.event } }];
  },
};

const RESOLVERS: Record<QueryName, QueryResolver> = {
  'charge-points': chargePoints,
  'charge-point': chargePoint,
  'transactions-active': transactionsActive,
  'meter-history': meterHistory,
  'status-history': statusHistory,
  'device-events': deviceEvents,
};

export function resolveQuery(name: QueryName): QueryResolver {
  return RESOLVERS[name];
}

function stringParam(params: QueryParams, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing or invalid string param: ${key}`);
  }
  return v;
}

// Empty strings → null. proto strings can't be unset in proto3, so
// "" is the wire representation of "absent" and the protocol's wire
// shape uses nullable strings.
function nullableString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') return String(v);
  if (v === '') return null;
  return v;
}

// protobufjs decodes proto enums to their full string name (e.g.
// "UNIT_WH", "MEASURAND_VOLTAGE"). The wire shape just wants the
// user-readable suffix, so strip the type prefix. Filters out the
// proto3 zero-value "*_UNSPECIFIED" so consumers get null rather
// than a meaningless string.
function enumToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') return null;
  if (v === '' || v.endsWith('_UNSPECIFIED')) return null;
  const idx = v.indexOf('_');
  return idx >= 0 ? v.slice(idx + 1) : v;
}
