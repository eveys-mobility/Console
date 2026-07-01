import { z } from 'zod';

export const queryName = z.enum([
  'charge-points',
  'charge-point',
  'transactions-active',
  'meter-history',
  'status-history',
  'device-events',
]);
export type QueryName = z.infer<typeof queryName>;

export const queryParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type QueryParams = z.infer<typeof queryParams>;

// The gateway emits ISO-8601 with explicit +00:00 offset (Python isoformat).
// Use offset:true so zod accepts both `Z` and `±HH:MM`.
const isoTimestamp = z.string().datetime({ offset: true });

export const connectorState = z
  .object({
    connector_id: z.number().int().nonnegative(),
    status: z.string(),
    error_code: z.string().nullable(),
    last_changed_at: isoTimestamp.nullable(),
    /** Vendor-specific error code (OCPP 1.6 StatusNotification). */
    vendor_error_code: z.string().nullable().optional(),
    /** Free-text human-readable detail line on the StatusNotification. */
    info: z.string().nullable().optional(),
  })
  .passthrough();

// Mirrors the gateway's `GET /api/v1/charge-points` row shape (see
// docs/integration/02-gateway-rest-api.md). Anything the gateway can
// omit on a row must be `.nullable()` here, and anything the gateway
// adds in a future minor must be tolerated by the schema (see the
// `.passthrough()` at the bottom — accepts unknown fields rather than
// rejecting the whole row).
/** One row from the gateway's `reservations` table (ADR-0021).
 *  Three statuses: `Pending` (allocated id, charger hasn't replied
 *  yet), `Active` (charger Accepted; honoured until expiry or
 *  consumed by a matching StartTransaction), `Cancelled` (operator
 *  issued CancelReservation and the charger Accepted). A reservation
 *  consumed by a StartTransaction stays as `Active` in this table —
 *  the gateway has no separate "Used" status today; the Console
 *  derives "consumed by tx N" via id_tag + time-window matching. */
export const reservation = z
  .object({
    reservation_id: z.number().int().nonnegative(),
    connector_id: z.number().int().nonnegative(),
    id_tag: z.string(),
    /** The list endpoint includes this; the inlined `active_reservations`
     *  block on the charge-point detail row omits it. Optional so both
     *  shapes parse. */
    parent_id_tag: z.string().nullable().optional(),
    expiry_date: isoTimestamp.nullable(),
    status: z.string(),
    created_at: isoTimestamp.nullable().optional(),
    updated_at: isoTimestamp.nullable().optional(),
  })
  .passthrough();
export type Reservation = z.infer<typeof reservation>;

export const chargePointSummary = z
  .object({
    cp_id: z.string(),
    online: z.boolean(),
    pod_id: z.string().nullable(),
    vendor: z.string().nullable(),
    model: z.string().nullable(),
    firmware_version: z.string().nullable(),
    serial_number: z.string().nullable(),
    /** OCPP subprotocol negotiated on the charger's WS upgrade
     *  (`ocpp1.6` today; `ocpp2.0.1` per-row when that profile
     *  lands on the gateway). Null on rows that haven't booted
     *  since the gateway started recording the field. Surfaced on
     *  the fleet list + detail page header so operators don't
     *  guess which protocol the charger speaks. */
    ocpp_version: z.string().nullable().optional(),
    last_boot_at: isoTimestamp.nullable(),
    last_heartbeat_at: isoTimestamp.nullable(),
    last_status: z.string().nullable(),
    last_diagnostics_status: z.string().nullable().optional(),
    last_firmware_status: z.string().nullable().optional(),
    connectors: z.array(connectorState),
    /** Currently-Active reservations on this charger, inlined by the
     *  gateway's detail endpoint so the Commands tab can populate
     *  the CancelReservation dropdown without a second round-trip.
     *  Field is optional because the list endpoint omits it (only
     *  the detail endpoint inlines this). */
    active_reservations: z.array(reservation).optional(),
  })
  .passthrough();
export type ChargePointSummary = z.infer<typeof chargePointSummary>;

// Mirrors the gateway's transaction row shape (see #129/#130 PR).
// `started_reported_at` is the OCPP timestamp claimed by the charger;
// `started_received_at` is the gateway's wall-clock receive time.
// `meter_*_wh` and `consumed_wh` are integer Wh as the OCPP 1.6 native
// unit. `consumed_wh = meter_stop_wh - meter_start_wh` when stopped.
export const transactionSummary = z
  .object({
    transaction_id: z.number().int(),
    cp_id: z.string(),
    connector_id: z.number().int().nonnegative(),
    id_tag: z.string(),
    meter_start_wh: z.number(),
    meter_stop_wh: z.number().nullable(),
    consumed_wh: z.number().nullable(),
    started_reported_at: isoTimestamp,
    started_received_at: isoTimestamp,
    stopped_reported_at: isoTimestamp.nullable(),
    stopped_received_at: isoTimestamp.nullable(),
    stop_reason: z.string().nullable(),
  })
  .passthrough();
export type TransactionSummary = z.infer<typeof transactionSummary>;

// Live MeterValues sample. Produced server-side by the Console broker
// (one per `sampledValue` in the gateway's Kafka cp.meter event).
export const meterSample = z.object({
  cp_id: z.string(),
  transaction_id: z.number().int().nullable(),
  connector_id: z.number().int().nonnegative(),
  measurand: z.string(),
  // 'L1' / 'L2' / 'L3' / 'N' / null. Null = aggregate sample, no
  // per-phase breakdown. Needed by the chart on the transaction
  // detail page to plot per-phase lines from the live tail.
  phase: z.string().nullable(),
  value: z.number(),
  unit: z.string().nullable(),
  recorded_at: isoTimestamp,
});
export type MeterSample = z.infer<typeof meterSample>;

// Live StatusNotification, mapped server-side.
export const statusEvent = z.object({
  cp_id: z.string(),
  connector_id: z.number().int().nonnegative(),
  status: z.string(),
  error_code: z.string().nullable(),
  info: z.string().nullable(),
  reported_at: isoTimestamp,
});
export type StatusEvent = z.infer<typeof statusEvent>;

// Merged per-charger event stream. Server fans the gateway Kafka
// topics (cp.boot, cp.status, cp.meter, tx.started, tx.stopped) into
// a single chronological feed for the charger detail page. The summary
// line is pre-rendered server-side so the UI just paints it; `detail`
// carries the structured fields for the expand-on-click panel.
export const deviceEvent = z.object({
  at: isoTimestamp,
  kind: z.enum([
    'boot',
    'status',
    'meter',
    'tx-started',
    'tx-stopped',
    'connected',
    'disconnected',
    'diagnostics-status',
    'firmware-status',
  ]),
  summary: z.string(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  connector_id: z.number().int().nonnegative().nullable().optional(),
});
export type DeviceEvent = z.infer<typeof deviceEvent>;

export const snapshotForQuery = z.union([
  z.object({
    kind: z.literal('charge-points'),
    rows: z.array(chargePointSummary),
    // Cursor-paginated snapshot: pass back to subscribe to get the
    // next page. `null` means "you're on the last page".
    next_cursor: z.string().nullable().optional(),
    // Page-paginated snapshot: present when the subscription used
    // `page`/`page_size` instead of `cursor`. `total` lets the UI
    // render "Showing 1–100 of 873" without an extra round-trip.
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().optional(),
    total: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('charge-point'), row: chargePointSummary }),
  z.object({ kind: z.literal('transactions-active'), rows: z.array(transactionSummary) }),
  z.object({ kind: z.literal('meter-history'), rows: z.array(meterSample) }),
  z.object({ kind: z.literal('status-history'), rows: z.array(statusEvent) }),
  z.object({ kind: z.literal('device-events'), rows: z.array(deviceEvent) }),
]);
export type SnapshotForQuery = z.infer<typeof snapshotForQuery>;

export const deltaForQuery = z.union([
  z.object({
    kind: z.literal('charge-points'),
    op: z.enum(['upsert', 'remove']),
    row: chargePointSummary.optional(),
    cp_id: z.string().optional(),
  }),
  z.object({ kind: z.literal('charge-point'), row: chargePointSummary }),
  z.object({
    kind: z.literal('transactions-active'),
    op: z.enum(['upsert', 'remove']),
    row: transactionSummary.optional(),
    transaction_id: z.number().int().optional(),
  }),
  z.object({ kind: z.literal('meter-history'), append: meterSample }),
  z.object({ kind: z.literal('status-history'), append: statusEvent }),
  z.object({ kind: z.literal('device-events'), append: deviceEvent }),
]);
export type DeltaForQuery = z.infer<typeof deltaForQuery>;
