// Console-server proxy for the gateway's `/api/v1/authorizations` surface
// (#0013). Four passthrough endpoints; the browser only ever talks to the
// Console server, so we JWT-auth here and let the upstream call use the
// shared GATEWAY_TOKEN.
//
// List endpoint is fail-soft: on gateway error it returns
// `{ items: [], unavailable: true }` with a 200 — same envelope shape
// /sys/kpis uses — so the page shows an empty state instead of an error
// toast when the gateway hasn't been deployed yet. Mutations stay hard
// errors: the operator is explicitly acting and deserves to see what
// went wrong.

import type { GatewayClient } from '../rest/gateway-client.js';

interface RouteDeps {
  gateway: GatewayClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyApp = any;
type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

interface ListResponse {
  items: unknown[];
  unavailable: boolean;
}

const EMPTY_LIST: ListResponse = { items: [], unavailable: true };

async function requireAuth(req: { jwtVerify: () => Promise<unknown> }, reply: Reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  return undefined;
}

function gatewayError(reply: Reply, err: unknown) {
  const status = (err as { status?: number }).status ?? 502;
  return reply.code(status).send({
    error: 'gateway-unavailable',
    detail: err instanceof Error ? err.message : 'unknown',
  });
}

export async function registerSysAuthorizationsRoute(app: FastifyApp, deps: RouteDeps) {
  app.get(
    '/sys/authorizations',
    { preHandler: requireAuth },
    async (req: { query?: { status?: string; limit?: string } }): Promise<ListResponse> => {
      const params: { status?: string; limit?: number } = {};
      if (req.query?.status) params.status = req.query.status;
      if (req.query?.limit !== undefined) params.limit = Number(req.query.limit);
      try {
        const raw = (await deps.gateway.listAuthorizations(params)) as Partial<ListResponse>;
        return {
          items: Array.isArray(raw.items) ? raw.items : [],
          unavailable: false,
        };
      } catch {
        return EMPTY_LIST;
      }
    },
  );

  app.post(
    '/sys/authorizations/:cpId/approve',
    { preHandler: requireAuth },
    async (req: { params: { cpId: string } }, reply: Reply) => {
      try {
        return await deps.gateway.approveAuthorization(req.params.cpId);
      } catch (err) {
        return gatewayError(reply, err);
      }
    },
  );

  app.post(
    '/sys/authorizations/:cpId/reject',
    { preHandler: requireAuth },
    async (req: { params: { cpId: string } }, reply: Reply) => {
      try {
        return await deps.gateway.rejectAuthorization(req.params.cpId);
      } catch (err) {
        return gatewayError(reply, err);
      }
    },
  );

  app.post(
    '/sys/authorizations/:cpId/revoke',
    { preHandler: requireAuth },
    async (req: { params: { cpId: string } }, reply: Reply) => {
      try {
        return await deps.gateway.revokeAuthorization(req.params.cpId);
      } catch (err) {
        return gatewayError(reply, err);
      }
    },
  );
}
