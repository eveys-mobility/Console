// REST clients for the transactions surfaces.
//
// Two surfaces today:
//
//   - fetchChargePointTransactions(token, cpId, params)
//       → GET /sys/charge-points/:cp_id/transactions?active=…&limit=…&cursor=…
//     The row is leaner than a full TransactionDetail (no telemetry /
//     meter-value join). Pagination is cursor-based: the client treats
//     `next_cursor` as opaque and pushes/pops it onto a stack to power
//     Previous/Next.
//
//   - fetchTransaction(token, txId) + fetchMeterValues(token, cpId, params)
//       → GET /sys/transactions/:tx_id
//       → GET /sys/charge-points/:cp_id/meter-values
//     Per-transaction detail + meter-values time-series. Both call the
//     Console's REST proxy (single origin); the gateway token never
//     leaves the server. The detail page polls these via TanStack Query
//     — there is no WS broker query for single-tx detail.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export interface PhaseSnapshot {
  voltage_v: number | null;
  current_a: number | null;
  power_w: number | null;
  power_factor: number | null;
  occurred_at: string | null;
}

export interface SocSummary {
  start: number | null;
  last: number | null;
  delta: number | null;
}

export interface TransactionTelemetry {
  soc: SocSummary;
  // Keyed by phase label (typically 'L1' / 'L2' / 'L3'). 1-phase chargers
  // populate only one entry; some report 'N' or omit phase entirely —
  // the page renders only the entries actually present.
  phases: Record<string, PhaseSnapshot>;
}

export interface TransactionDetail {
  transaction_id: number;
  cp_id: string;
  connector_id: number;
  id_tag: string;
  meter_start_wh: number;
  meter_stop_wh: number | null;
  started_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  open: boolean;
  telemetry: TransactionTelemetry | null;
  /** Archive readability only; older gateways omit these additive fields. */
  telemetry_state?: 'available' | 'unavailable' | 'unconfigured';
  telemetry_error?: 'ARCHIVE_UNAVAILABLE' | 'ARCHIVE_UNCONFIGURED' | null;
}

export interface MeterValueSample {
  cp_id: string;
  connector_id: number;
  transaction_id: number | null;
  occurred_at: string;
  // OCPP wire form: 'Power.Active.Import', 'Energy.Active.Import.Register',
  // 'Voltage', 'Current.Import', 'SoC', 'Temperature', etc.
  measurand: string;
  // 'L1' / 'L2' / 'L3' / 'N' / null. Per-phase samples have the phase
  // label; aggregate samples (no phase reported by the charger) are null.
  phase: string | null;
  // 'W' / 'kW' / 'V' / 'A' / 'Wh' / 'kWh' / '%' / 'Celsius' etc.
  unit: string;
  value: number;
}

export interface MeterValuesResponse {
  meter_values: MeterValueSample[];
  next_cursor: string | null;
}

export interface MeterValuesParams {
  from: string;
  to: string;
  measurand?: string;
  connector_id?: number;
  limit?: number;
}

export interface TransactionRow {
  transaction_id: number;
  cp_id: string;
  connector_id: number;
  id_tag: string;
  /** Wh integer at session start. */
  meter_start_wh: number;
  /** ISO-8601 string. */
  started_at: string;
  /** Wh integer at session stop, or null while the session is open. */
  meter_stop_wh: number | null;
  /** Energy delivered, computed gateway-side as
   *  `meter_stop_wh - meter_start_wh`. Null while the session is open. */
  consumed_wh: number | null;
  /** ISO-8601 string, or null while the session is open. */
  stopped_at: string | null;
  /** OCPP `Reason` enum value if the charger sent one, else null. */
  stop_reason: string | null;
  /** Convenience flag the gateway already computes. */
  open: boolean;
}

export interface PaginationBlock {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface TransactionsList {
  transactions: TransactionRow[];
  /** Cursor mode response field — null when there are no more pages
   *  in cursor mode, or whenever the request used page mode (the
   *  gateway still serializes the key, just as null). */
  next_cursor: string | null;
  /** Page mode response field — present only when the request used
   *  `page` + `page_size`. Cursor-mode responses omit it. */
  pagination?: PaginationBlock;
}

export interface ListParams {
  active?: boolean;
  limit?: number;
  cursor?: string;
}

export async function fetchTransaction(token: string, txId: number): Promise<TransactionDetail> {
  const res = await fetch(`${BASE}/sys/transactions/${encodeURIComponent(String(txId))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/transactions/${txId} ${res.status}`);
  return (await res.json()) as TransactionDetail;
}

export async function fetchMeterValues(
  token: string,
  cpId: string,
  params: MeterValuesParams,
): Promise<MeterValuesResponse> {
  const qs = new URLSearchParams();
  qs.set('from', params.from);
  qs.set('to', params.to);
  if (params.measurand) qs.set('measurand', params.measurand);
  if (params.connector_id !== undefined) qs.set('connector_id', String(params.connector_id));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const url = `${BASE}/sys/charge-points/${encodeURIComponent(cpId)}/meter-values?${qs.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/charge-points/${cpId}/meter-values ${res.status}`);
  return (await res.json()) as MeterValuesResponse;
}

export async function fetchChargePointTransactions(
  token: string,
  cpId: string,
  params: ListParams = {},
): Promise<TransactionsList> {
  const qs = new URLSearchParams();
  if (params.active !== undefined) qs.set('active', String(params.active));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const suffix = qs.toString() ? `?${qs}` : '';
  const url = `${BASE}/sys/charge-points/${encodeURIComponent(cpId)}/transactions${suffix}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sys/charge-points/${cpId}/transactions ${res.status}`);
  return (await res.json()) as TransactionsList;
}

/**
 * Page through `/sys/charge-points/:cp_id/transactions` accumulating
 * up to `maxPages × pageSize` rows. Returns `truncated: true` if the
 * cap was hit with more pages still available — the StatisticsCard
 * uses that flag to render a footnote so operators know older
 * sessions exist beyond the window.
 *
 * Defaults (5 × 500 = 2,500 rows) keep the wire cost bounded for
 * the largest realistic operator: a high-utilisation site doing 30
 * sessions a day still fits two months in a single fetch. Beyond
 * that the right answer is a gateway-side aggregation endpoint, not
 * more pages.
 */
export async function fetchAllChargePointTransactions(
  token: string,
  cpId: string,
  maxPages: number = 5,
  pageSize: number = 500,
): Promise<{ transactions: TransactionRow[]; truncated: boolean }> {
  const all: TransactionRow[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let i = 0; i < maxPages; i += 1) {
    const params: ListParams = { limit: pageSize };
    if (cursor) params.cursor = cursor;
    const page = await fetchChargePointTransactions(token, cpId, params);
    all.push(...page.transactions);
    if (!page.next_cursor) {
      cursor = undefined;
      break;
    }
    cursor = page.next_cursor;
    if (i === maxPages - 1) {
      // Hit the cap with `next_cursor` still set → more rows exist
      // upstream that we deliberately didn't fetch.
      truncated = true;
      // eslint-disable-next-line no-console -- intentional operator-visible signal
      console.warn(
        `fetchAllChargePointTransactions(${cpId}): truncated at ${maxPages} pages; older sessions exist`,
      );
    }
  }
  return { transactions: all, truncated };
}

// ----------------------------------------------------------------------------
// Global transaction list (PR A1 of #188)
// ----------------------------------------------------------------------------
//
// The TransactionsPage uses this — distinct from `fetchChargePointTransactions`
// above (which scopes to one charger). The shape is the same row type
// because the gateway returns the same projection; the difference is
// which endpoint we hit and which filters it accepts.

/** Closed-set status the UI sends; the server translates to the gateway's
 *  active=true|false|absent. */
export type TransactionStatusFilter = 'active' | 'finished' | 'all';

/** Sortable columns. Mirrors the gateway's closed enum (id is the
 *  default — `started_at` is most useful in the UI). */
export type TransactionsSortKey = 'id' | 'started_at' | 'stopped_at' | 'consumed_wh';
export type TransactionsSortDir = 'asc' | 'desc';

export interface TransactionsListParams {
  status?: TransactionStatusFilter;
  cp_id?: string;
  id_tag?: string;
  from?: string;
  to?: string;
  /** Cursor pagination (newest-first by id). Mutually exclusive with
   *  `page`/`page_size`. Cursor mode requires the default sort. */
  cursor?: string;
  /** Page-mode pagination. Required when sorting by anything other
   *  than `id` — the gateway 400s on `cursor` + non-id sort. */
  page?: number;
  page_size?: number;
  limit?: number;
  sort?: TransactionsSortKey;
  dir?: TransactionsSortDir;
}

export async function fetchTransactions(
  token: string,
  params: TransactionsListParams = {},
): Promise<TransactionsList> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.cp_id) qs.set('cp_id', params.cp_id);
  if (params.id_tag) qs.set('id_tag', params.id_tag);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.page !== undefined) qs.set('page', String(params.page));
  if (params.page_size !== undefined) qs.set('page_size', String(params.page_size));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.sort) qs.set('sort', params.sort);
  if (params.dir) qs.set('dir', params.dir);
  const suffix = qs.toString() ? `?${qs}` : '';
  const url = `${BASE}/sys/transactions${suffix}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sys/transactions ${res.status}`);
  return (await res.json()) as TransactionsList;
}
