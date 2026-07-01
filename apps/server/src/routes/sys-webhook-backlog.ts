// Console-side proxy for the gateway's `/api/v1/webhook-backlog` admin
// surface (E3-9 tail). Same shape as sys-transactions.ts / sys-authorizations.ts:
// browser hits us (JWT auth); we forward to the gateway with the server-side
// bearer token; response passes through 1:1 with the gateway's shape preserved.
//
//   GET    /sys/webhook-backlog?dead=&event_type=&cursor=&limit=
//          → GET  /api/v1/webhook-backlog?...
//   GET    /sys/webhook-backlog/:id
//          → GET  /api/v1/webhook-backlog/{id}
//   POST   /sys/webhook-backlog/:id/replay
//          → POST /api/v1/webhook-backlog/{id}/replay
//   DELETE /sys/webhook-backlog/:id
//          → DELETE /api/v1/webhook-backlog/{id}
//   POST   /sys/webhook-backlog/replay-dead
//          → POST /api/v1/webhook-backlog/replay-dead
//   POST   /sys/webhook-backlog/purge-dead
//          → POST /api/v1/webhook-backlog/purge-dead
//
// The gateway returns snake_case JSON; we pass it through unchanged so the
// Console UI can bind directly to the frozen wire shape documented in
// docs/integration/03-webhooks.md.

import type { GatewayClient } from '../rest/gateway-client.js';

interface RouteDeps {
  gateway: GatewayClient;
}

interface ListQuery {
  dead?: string;
  event_type?: string | string[];
  cursor?: string;
  limit?: string;
}

interface ReplayDeadBody {
  event_type?: string[] | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSysWebhookBacklogRoute(app: any, deps: RouteDeps) {
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

  const normaliseEventTypes = (raw: string | string[] | undefined): string[] | undefined => {
    if (raw === undefined) return undefined;
    return Array.isArray(raw) ? raw : [raw];
  };

  app.get(
    '/sys/webhook-backlog',
    { preHandler: requireAuth },
    async (
      req: { query: ListQuery },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const q = req.query ?? {};
      const params: Parameters<typeof deps.gateway.listWebhookBacklog>[0] = {};

      if (q.dead !== undefined && q.dead !== '') {
        if (q.dead === 'true') params.dead = true;
        else if (q.dead === 'false') params.dead = false;
        else {
          return reply.code(400).send({ error: 'bad-request', detail: 'dead must be true|false' });
        }
      }
      const events = normaliseEventTypes(q.event_type);
      if (events) params.event_type = events;
      if (q.cursor) params.cursor = q.cursor;
      if (q.limit !== undefined && q.limit !== '') {
        const n = Number(q.limit);
        if (!Number.isInteger(n) || n <= 0 || n > 500) {
          return reply.code(400).send({ error: 'bad-request', detail: 'limit must be 1..500' });
        }
        params.limit = n;
      }

      try {
        return await deps.gateway.listWebhookBacklog(params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.get(
    '/sys/webhook-backlog/:id',
    { preHandler: requireAuth },
    async (
      req: { params: { id: string } },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      try {
        return await deps.gateway.getWebhookBacklog(req.params.id);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.post(
    '/sys/webhook-backlog/:id/replay',
    { preHandler: requireAuth },
    async (
      req: { params: { id: string } },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      try {
        return await deps.gateway.replayWebhookBacklog(req.params.id);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.delete(
    '/sys/webhook-backlog/:id',
    { preHandler: requireAuth },
    async (
      req: { params: { id: string } },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      try {
        return await deps.gateway.purgeWebhookBacklog(req.params.id);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.post(
    '/sys/webhook-backlog/replay-dead',
    { preHandler: requireAuth },
    async (
      req: { body: ReplayDeadBody | undefined },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const eventTypes = req.body?.event_type ?? undefined;
      // Guard: array of strings only. Bad shapes get 400 before we
      // waste a round-trip to the gateway.
      if (
        eventTypes !== undefined &&
        (!Array.isArray(eventTypes) || eventTypes.some((s) => typeof s !== 'string'))
      ) {
        return reply
          .code(400)
          .send({ error: 'bad-request', detail: 'event_type must be a string array' });
      }
      try {
        const params: Parameters<typeof deps.gateway.replayDeadWebhookBacklog>[0] = {};
        if (eventTypes !== undefined) params.event_type = eventTypes;
        return await deps.gateway.replayDeadWebhookBacklog(params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );

  app.post(
    '/sys/webhook-backlog/purge-dead',
    { preHandler: requireAuth },
    async (
      req: { body: ReplayDeadBody | undefined },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const eventTypes = req.body?.event_type ?? undefined;
      // Same validation as replay-dead — both endpoints share the
      // (optional) event_type array filter contract. Bad shapes get
      // 400 before we round-trip to the gateway.
      if (
        eventTypes !== undefined &&
        (!Array.isArray(eventTypes) || eventTypes.some((s) => typeof s !== 'string'))
      ) {
        return reply
          .code(400)
          .send({ error: 'bad-request', detail: 'event_type must be a string array' });
      }
      try {
        const params: Parameters<typeof deps.gateway.purgeDeadWebhookBacklog>[0] = {};
        if (eventTypes !== undefined) params.event_type = eventTypes;
        return await deps.gateway.purgeDeadWebhookBacklog(params);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );
}
