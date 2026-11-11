// Route test for the charge-point list proxy. Pass-through to the
// gateway's `GET /api/v1/charge-points` with a whitelisted filter set;
// fail-soft like `/sys/authorizations` so the polling panel on the
// Authorizations page shows an empty state instead of an error toast
// when the gateway is down.

import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSysChargePointsRoute } from '../src/routes/sys-charge-points.js';

const JWT_SECRET = 'a-test-secret-of-at-least-16-bytes';

interface FakeGateway {
  listChargePoints: ReturnType<typeof vi.fn>;
}

async function buildApp(gateway: FakeGateway): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerSysChargePointsRoute(app, { gateway: gateway as any });
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance): string {
  return `Bearer ${app.jwt.sign({ sub: 'tester' })}`;
}

describe('GET /sys/charge-points', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = { listChargePoints: vi.fn() };
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/sys/charge-points' });
    expect(res.statusCode).toBe(401);
    expect(gateway.listChargePoints).not.toHaveBeenCalled();
  });

  it('forwards the whitelisted filters and surfaces the upstream rows', async () => {
    gateway.listChargePoints.mockResolvedValue({
      charge_points: [{ cp_id: 'SN20052210130151', last_boot_status: 'Pending' }],
      next_cursor: null,
      request_id: 'r1',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/sys/charge-points?last_boot_status=Pending&online=true&limit=200&bogus=1',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(gateway.listChargePoints).toHaveBeenCalledWith({
      last_boot_status: 'Pending',
      online: true,
      limit: 200,
    });
    const body = res.json();
    expect(body.unavailable).toBe(false);
    expect(body.charge_points).toEqual([
      { cp_id: 'SN20052210130151', last_boot_status: 'Pending' },
    ]);
  });

  it('is fail-soft: gateway error → empty list + unavailable:true, still 200', async () => {
    gateway.listChargePoints.mockRejectedValue(Object.assign(new Error('boom'), { status: 502 }));
    const res = await app.inject({
      method: 'GET',
      url: '/sys/charge-points?last_boot_status=Pending',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ charge_points: [], unavailable: true });
  });
});
