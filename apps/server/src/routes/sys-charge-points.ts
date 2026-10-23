// Console-server proxy for the gateway's `GET /api/v1/charge-points`.
// The live fleet views go through the WS broker; this REST route backs
// polled side panels (the Authorizations page lists chargers whose last
// BootNotification the backend answered `Pending`). Only a small
// whitelist of filters is forwarded — the browser never talks to the
// gateway directly and must not be able to shape arbitrary upstream
// queries.
//
// Fail-soft like `/sys/authorizations`: a gateway error returns
// `{ charge_points: [], unavailable: true }` with a 200 so the panel
// shows "gateway unavailable" instead of an error toast every 5 s.

import type { GatewayClient } from '../rest/gateway-client.js';

interface RouteDeps {
  gateway: GatewayClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyApp = any;
type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

interface ListResponse {
  charge_points: unknown[];
  unavailable: boolean;
}

const EMPTY_LIST: ListResponse = { charge_points: [], unavailable: true };

async function requireAuth(req: { jwtVerify: () => Promise<unknown> }, reply: Reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
  return undefined;
}

interface Query {
  last_boot_status?: string;
  online?: string;
  limit?: string;
}

export async function registerSysChargePointsRoute(app: FastifyApp, deps: RouteDeps) {
  app.get(
    '/sys/charge-points',
    { preHandler: requireAuth },
    async (req: { query?: Query }): Promise<ListResponse> => {
      const params: { last_boot_status?: string; online?: boolean; limit?: number } = {};
      const q = req.query ?? {};
      if (typeof q.last_boot_status === 'string' && q.last_boot_status.length > 0) {
        params.last_boot_status = q.last_boot_status;
      }
      if (q.online === 'true') params.online = true;
      if (q.online === 'false') params.online = false;
      if (q.limit !== undefined) {
        const limit = Number(q.limit);
        if (Number.isFinite(limit) && limit > 0) params.limit = limit;
      }
      try {
        const raw = (await deps.gateway.listChargePoints(params)) as {
          charge_points?: unknown;
        };
        return {
          charge_points: Array.isArray(raw.charge_points) ? raw.charge_points : [],
          unavailable: false,
        };
      } catch {
        return EMPTY_LIST;
      }
    },
  );
}
