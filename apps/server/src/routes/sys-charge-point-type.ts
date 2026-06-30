// Proxies the gateway's `PATCH /api/v1/charge-points/{cp_id}/type` so
// the browser only ever talks to the Console server.
//
// We expose POST on the Console side to dodge a CORS preflight; the
// proxy translates to PATCH upstream. Body shape mirrors the gateway:
// `{charger_type: 'ac' | 'dc' | null}`.

import type { GatewayClient } from '../rest/gateway-client.js';

interface RouteDeps {
  gateway: GatewayClient;
}

interface TypeBody {
  charger_type?: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSysChargePointTypeRoute(app: any, deps: RouteDeps) {
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
        /* fall through */
      }
    }
    return reply.code(status).send({
      error: 'gateway-unavailable',
      detail: err instanceof Error ? err.message : 'unknown',
    });
  };

  app.post(
    '/sys/charge-points/:cp_id/type',
    { preHandler: requireAuth },
    async (
      req: { params: { cp_id: string }; body?: TypeBody },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const { cp_id } = req.params;
      if (!cp_id) {
        return reply.code(400).send({ error: 'bad-request', detail: 'cp_id required' });
      }
      const raw = req.body?.charger_type;
      let charger_type: 'ac' | 'dc' | null;
      if (raw === null || raw === undefined) {
        charger_type = null;
      } else if (raw === 'ac' || raw === 'dc') {
        charger_type = raw;
      } else {
        return reply
          .code(400)
          .send({ error: 'bad-request', detail: "charger_type must be 'ac', 'dc', or null" });
      }
      try {
        return await deps.gateway.patchChargerType(cp_id, charger_type);
      } catch (err) {
        return handleGatewayError(err, reply);
      }
    },
  );
}
