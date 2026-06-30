// Proxies the gateway's transactions surface so the browser only ever
// talks to the Console server. Three endpoints, each mapped 1:1 to the
// gateway:
//
//   GET /sys/transactions?status=&cp_id=&id_tag=&from=&to=&cursor=&limit=
//       → GET /api/v1/transactions?... (audit list, PR A1 of #188)
//
//   GET /sys/transactions/:tx_id
//       → GET /api/v1/transactions/{transaction_id}
//
//   GET /sys/charge-points/:cp_id/meter-values?from=...&to=...&measurand=...
//       → GET /api/v1/charge-points/{cp_id}/meter-values?...
//
// Why a proxy and not a direct browser-to-gateway call: same-origin keeps
// auth simple (Console JWT, same as every other surface), keeps the
// gateway token server-side, and avoids a second CORS surface for the
// browser. Single Console origin is the rule everywhere here.

import type { GatewayClient } from '../rest/gateway-client.js';

interface RouteDeps {
  gateway: GatewayClient;
}

interface ListQuery {
  status?: string;
  cp_id?: string;
  id_tag?: string;
  from?: string;
  to?: string;
  cursor?: string;
  page?: string;
  page_size?: string;
  limit?: string;
  sort?: string;
  dir?: string;
}

interface MeterValuesQuery {
  from?: string;
  to?: string;
  measurand?: string;
  connector_id?: string;
  limit?: string;
}

interface AggregateQuery {
  from?: string;
  to?: string;
  bucket?: string;
  group_by?: string;
}

interface TxFramesQuery {
  limit?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSysTransactionsRoute(app: any, deps: RouteDeps) {
  const requireAuth = async (
    req: { jwtVerify: () => Promise<unknown> },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return undefined;
  };

  const handleGatewayError = (
    err: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const status = (err as { status?: number }).status ?? 502;
    const body = (err as { body?: string }).body;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body) as unknown;
        return reply.code(status).send(parsed);
      } catch {
        /* fall through to the generic envelope */
      }
    }
    return reply.code(status).send({
      error: 'gateway-unavailable',
      detail: err instanceof Error ? err.message : 'unknown',
    });
  };

  app.get(
    '/sys/transactions',
    { preHandler: requireAuth },
    async (
      req: { query: ListQuery },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const q = req.query ?? {};
      const params: Parameters<typeof deps.gateway.listTransactions>[0] = {};

      // `status` is a closed enum on the UI side: active | finished |
      // all. The gateway only knows `active=true|false|absent`, so we
      // translate. Anything else (incl. empty / typo) is a hard 400 —
      // silently mapping unknown values to "all" would mask UI bugs.
      if (q.status !== undefined && q.status !== '') {
        if (q.status === 'active') params.active = true;
        else if (q.status === 'finished') params.active = false;
        else if (q.status === 'all') {
          /* leave active unset */
        } else {
          return reply.code(400).send({
            error: 'bad-request',
            detail: 'status must be active|finished|all',
          });
        }
      }

      if (q.cp_id) params.cp_id = q.cp_id;
      if (q.id_tag) params.id_tag = q.id_tag;
      if (q.from) params.from = q.from;
      if (q.to) params.to = q.to;
      if (q.cursor) params.cursor = q.cursor;

      if (q.limit !== undefined && q.limit !== '') {
        const n = Number(q.limit);
        if (!Number.isInteger(n) || n <= 0 || n > 1000) {
          return reply.code(400).send({ error: 'bad-request', detail: 'limit must be 1..1000' });
        }
        params.limit = n;
      }

      // Page-mode pagination is required when the operator sorts on
      // anything but the default; the gateway 400s on `cursor + non-id
      // sort`. The Console UI flips to page mode automatically when a
      // column-header sort is active; this just forwards verbatim.
      if (q.page !== undefined && q.page !== '') {
        const n = Number(q.page);
        if (!Number.isInteger(n) || n <= 0) {
          return reply.code(400).send({ error: 'bad-request', detail: 'page must be >= 1' });
        }
        params.page = n;
      }
      if (q.page_size !== undefined && q.page_size !== '') {
        const n = Number(q.page_size);
        if (!Number.isInteger(n) || n <= 0 || n > 1000) {
          return reply
            .code(400)
            .send({ error: 'bad-request', detail: 'page_size must be 1..1000' });
        }
        params.page_size = n;
      }

      if (q.sort !== undefined && q.sort !== '') {
        if (
          q.sort === 'id' ||
          q.sort === 'started_at' ||
          q.sort === 'stopped_at' ||
          q.sort === 'consumed_wh'
        ) {
          params.sort = q.sort;
        } else {
          return reply.code(400).send({
            error: 'bad-request',
            detail: 'sort must be id|started_at|stopped_at|consumed_wh',
          });
        }
      }
      if (q.dir !== undefined && q.dir !== '') {
        if (q.dir === 'asc' || q.dir === 'desc') {
          params.dir = q.dir;
        } else {
          return reply.code(400).send({ error: 'bad-request', detail: 'dir must be asc|desc' });
        }
      }

      try {
        return await deps.gateway.listTransactions(params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.get(
    '/sys/transactions/aggregate',
    { preHandler: requireAuth },
    async (
      req: { query: AggregateQuery },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const q = req.query ?? {};
      if (!q.from || !q.to) {
        return reply.code(400).send({ error: 'bad-request', detail: 'from and to are required' });
      }
      const params: Parameters<typeof deps.gateway.aggregateTransactions>[0] = {
        from: q.from,
        to: q.to,
      };
      if (q.bucket !== undefined && q.bucket !== '') {
        if (q.bucket === 'hour' || q.bucket === 'day') {
          params.bucket = q.bucket;
        } else {
          return reply.code(400).send({ error: 'bad-request', detail: 'bucket must be hour|day' });
        }
      }
      if (q.group_by !== undefined && q.group_by !== '') {
        if (q.group_by === 'none' || q.group_by === 'cp_id' || q.group_by === 'id_tag') {
          params.group_by = q.group_by;
        } else {
          return reply
            .code(400)
            .send({ error: 'bad-request', detail: 'group_by must be none|cp_id|id_tag' });
        }
      }
      try {
        return await deps.gateway.aggregateTransactions(params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.get(
    '/sys/transactions/:tx_id',
    { preHandler: requireAuth },
    async (
      req: { params: { tx_id: string } },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const raw = req.params.tx_id;
      const txId = Number(raw);
      if (!Number.isInteger(txId) || txId <= 0) {
        return reply
          .code(400)
          .send({ error: 'bad-request', detail: 'tx_id must be a positive integer' });
      }
      try {
        return await deps.gateway.getTransaction(txId);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.get(
    '/sys/transactions/:tx_id/frames',
    { preHandler: requireAuth },
    async (
      req: { params: { tx_id: string }; query: TxFramesQuery },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const txId = Number(req.params.tx_id);
      if (!Number.isInteger(txId) || txId <= 0) {
        return reply
          .code(400)
          .send({ error: 'bad-request', detail: 'tx_id must be a positive integer' });
      }
      const params: Parameters<typeof deps.gateway.listTransactionFrames>[1] = {};
      const rawLimit = req.query?.limit;
      if (rawLimit !== undefined && rawLimit !== '') {
        const n = Number(rawLimit);
        if (!Number.isInteger(n) || n <= 0 || n > 10_000) {
          return reply.code(400).send({ error: 'bad-request', detail: 'limit must be 1..10000' });
        }
        params.limit = n;
      }
      try {
        return await deps.gateway.listTransactionFrames(txId, params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.get(
    '/sys/charge-points/:cp_id/meter-values',
    { preHandler: requireAuth },
    async (
      req: { params: { cp_id: string }; query: MeterValuesQuery },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const { cp_id } = req.params;
      const { from, to, measurand, connector_id, limit } = req.query ?? {};
      if (!from || !to) {
        return reply.code(400).send({ error: 'bad-request', detail: 'from and to are required' });
      }
      const params: Parameters<GatewayClient['listMeterValues']>[1] = { from, to };
      if (measurand) params.measurand = measurand;
      if (connector_id !== undefined) {
        const n = Number(connector_id);
        if (!Number.isInteger(n) || n < 0) {
          return reply
            .code(400)
            .send({ error: 'bad-request', detail: 'connector_id must be an integer' });
        }
        params.connector_id = n;
      }
      if (limit !== undefined) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n <= 0 || n > 10_000) {
          return reply.code(400).send({ error: 'bad-request', detail: 'limit must be 1..10000' });
        }
        params.limit = n;
      }
      try {
        const upstream = await deps.gateway.listMeterValues(cp_id, params);
        return mapMeterValues(upstream);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );
}

interface UpstreamMeterRow {
  occurred_at: string;
  cp_id: string;
  connector_id: number;
  transaction_id: number | null;
  // Live gateways nest the measurand under `sample.*`; older tests
  // and fixtures hand the same fields back flat. Read either shape.
  sample?: {
    value?: number | null;
    measurand?: string | null;
    phase?: string | null;
    unit?: string | null;
  } | null;
  value?: number | null;
  measurand?: string | null;
  phase?: string | null;
  unit?: string | null;
  [key: string]: unknown;
}

interface UpstreamMeterValues {
  meter_values: UpstreamMeterRow[];
  next_cursor?: string | null;
  [key: string]: unknown;
}

/** Flatten `sample.{value,measurand,phase,unit}` onto the row so the
 *  Console UI's MeterValueSample (flat shape) keeps working without
 *  knowing about the gateway's nested storage form. Pure function over
 *  the upstream JSON. Missing measurand defaults to
 *  `Energy.Active.Import.Register` (the OCPP-1.6 default sample). */
export function mapMeterValues(upstream: unknown): {
  meter_values: Array<{
    cp_id: string;
    connector_id: number;
    transaction_id: number | null;
    occurred_at: string;
    measurand: string;
    phase: string | null;
    unit: string;
    value: number;
  }>;
  next_cursor: string | null;
} {
  const u = upstream as UpstreamMeterValues;
  const rows = Array.isArray(u?.meter_values) ? u.meter_values : [];
  const out: ReturnType<typeof mapMeterValues>['meter_values'] = [];
  for (const r of rows) {
    // Prefer the nested `sample.*` form (live gateway) and fall back
    // to the flat form (fixtures / unit tests). A row that carries
    // neither a `sample.value` nor a top-level `value` is skipped —
    // there's nothing to chart.
    const sample = r.sample ?? {};
    const rawValue = sample.value ?? r.value;
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const measurand = sample.measurand ?? r.measurand ?? null;
    const phase = sample.phase ?? r.phase ?? null;
    const unit = sample.unit ?? r.unit ?? null;
    out.push({
      cp_id: r.cp_id,
      connector_id: r.connector_id,
      transaction_id: r.transaction_id,
      occurred_at: r.occurred_at,
      measurand:
        typeof measurand === 'string' && measurand ? measurand : 'Energy.Active.Import.Register',
      phase: typeof phase === 'string' && phase ? phase : null,
      unit: typeof unit === 'string' && unit ? unit : '',
      value,
    });
  }
  return {
    meter_values: out,
    next_cursor: u?.next_cursor ?? null,
  };
}
