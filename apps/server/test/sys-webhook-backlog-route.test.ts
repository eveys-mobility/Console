// Route test for the webhook-backlog admin proxy (E3-9 tail).
//
// The proxy is a thin pass-through over the gateway client. We assert:
// (a) JWT auth on every method,
// (b) query params translate into the client's typed shape,
// (c) upstream body / status passes through unchanged,
// (d) a gateway 4xx error envelope survives translation,
// (e) validation on the console side (dead=?, limit=?, event_type list).

import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSysWebhookBacklogRoute } from '../src/routes/sys-webhook-backlog.js';

const JWT_SECRET = 'a-test-secret-of-at-least-16-bytes';

interface FakeGateway {
  listWebhookBacklog: ReturnType<typeof vi.fn>;
  getWebhookBacklog: ReturnType<typeof vi.fn>;
  replayWebhookBacklog: ReturnType<typeof vi.fn>;
  purgeWebhookBacklog: ReturnType<typeof vi.fn>;
  replayDeadWebhookBacklog: ReturnType<typeof vi.fn>;
}

function makeFakeGateway(): FakeGateway {
  return {
    listWebhookBacklog: vi.fn(),
    getWebhookBacklog: vi.fn(),
    replayWebhookBacklog: vi.fn(),
    purgeWebhookBacklog: vi.fn(),
    replayDeadWebhookBacklog: vi.fn(),
  };
}

async function buildApp(gateway: FakeGateway): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await registerSysWebhookBacklogRoute(app, { gateway: gateway as any });
  await app.ready();
  return app;
}

function authHeader(app: FastifyInstance): string {
  const token = app.jwt.sign({ sub: 'tester' });
  return `Bearer ${token}`;
}

describe('GET /sys/webhook-backlog', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = makeFakeGateway();
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({ method: 'GET', url: '/sys/webhook-backlog' });
    expect(res.statusCode).toBe(401);
    expect(gateway.listWebhookBacklog).not.toHaveBeenCalled();
  });

  it('passes the upstream body through unchanged', async () => {
    const upstream = {
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          event_id: '22222222-2222-2222-2222-222222222222',
          event_type: 'cp.boot',
          url: 'https://backend.example/webhooks/cp-boot',
          signature: 'sha256=abc',
          created_at: '2026-07-01T12:00:00+00:00',
          next_attempt_at: '2026-07-01T12:05:00+00:00',
          attempts: 2,
          last_error: null,
          dead: false,
        },
      ],
      next_cursor: null,
    };
    gateway.listWebhookBacklog.mockResolvedValue(upstream);
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(upstream);
    expect(gateway.listWebhookBacklog).toHaveBeenCalledWith({});
  });

  it('coerces dead=true, dead=false, and forwards event_type + cursor + limit', async () => {
    gateway.listWebhookBacklog.mockResolvedValue({ rows: [], next_cursor: null });
    await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog?dead=true&event_type=cp.boot&event_type=tx.stopped&cursor=abc&limit=25',
      headers: { authorization: authHeader(app) },
    });
    expect(gateway.listWebhookBacklog).toHaveBeenCalledWith({
      dead: true,
      event_type: ['cp.boot', 'tx.stopped'],
      cursor: 'abc',
      limit: 25,
    });
  });

  it('rejects a garbage dead value with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog?dead=maybe',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(400);
    expect(gateway.listWebhookBacklog).not.toHaveBeenCalled();
  });

  it('rejects limit outside 1..500 with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog?limit=999',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(400);
    expect(gateway.listWebhookBacklog).not.toHaveBeenCalled();
  });

  it('forwards a gateway error envelope with its status', async () => {
    const err = { status: 502, body: JSON.stringify({ error: 'upstream_bad' }), path: '/x' };
    gateway.listWebhookBacklog.mockRejectedValue(err);
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_bad' });
  });
});

describe('GET /sys/webhook-backlog/:id', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = makeFakeGateway();
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog/11111111-1111-1111-1111-111111111111',
    });
    expect(res.statusCode).toBe(401);
  });

  it('forwards the id and returns the gateway body', async () => {
    gateway.getWebhookBacklog.mockResolvedValue({ id: 'abc', body_b64: 'e30=' });
    const res = await app.inject({
      method: 'GET',
      url: '/sys/webhook-backlog/abc',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(gateway.getWebhookBacklog).toHaveBeenCalledWith('abc');
  });
});

describe('POST /sys/webhook-backlog/:id/replay', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = makeFakeGateway();
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/abc/replay',
    });
    expect(res.statusCode).toBe(401);
  });

  it('forwards to the gateway on happy path', async () => {
    gateway.replayWebhookBacklog.mockResolvedValue({ id: 'abc', dead: false });
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/abc/replay',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(gateway.replayWebhookBacklog).toHaveBeenCalledWith('abc');
  });

  it('passes a 409 refuse-live-row through unchanged', async () => {
    const err = {
      status: 409,
      body: JSON.stringify({ error: 'BAD_REQUEST', message: 'row is not dead' }),
      path: '/x',
    };
    gateway.replayWebhookBacklog.mockRejectedValue(err);
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/abc/replay',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('DELETE /sys/webhook-backlog/:id', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = makeFakeGateway();
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/sys/webhook-backlog/abc' });
    expect(res.statusCode).toBe(401);
  });

  it('forwards to the gateway on happy path', async () => {
    gateway.purgeWebhookBacklog.mockResolvedValue({ deleted: true, id: 'abc' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/sys/webhook-backlog/abc',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(gateway.purgeWebhookBacklog).toHaveBeenCalledWith('abc');
  });
});

describe('POST /sys/webhook-backlog/replay-dead', () => {
  let gateway: FakeGateway;
  let app: FastifyInstance;

  beforeEach(async () => {
    gateway = makeFakeGateway();
    app = await buildApp(gateway);
  });

  it('returns 401 without a JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/replay-dead',
    });
    expect(res.statusCode).toBe(401);
  });

  it('forwards without a body', async () => {
    gateway.replayDeadWebhookBacklog.mockResolvedValue({ count: 3 });
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/replay-dead',
      headers: { authorization: authHeader(app) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 3 });
    // No body -> no event_type key forwarded (bulk replay-all).
    expect(gateway.replayDeadWebhookBacklog).toHaveBeenCalledWith({});
  });

  it('forwards an event_type array', async () => {
    gateway.replayDeadWebhookBacklog.mockResolvedValue({ count: 1 });
    await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/replay-dead',
      headers: { authorization: authHeader(app), 'content-type': 'application/json' },
      payload: { event_type: ['cp.boot'] },
    });
    expect(gateway.replayDeadWebhookBacklog).toHaveBeenCalledWith({
      event_type: ['cp.boot'],
    });
  });

  it('rejects a non-string-array event_type with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sys/webhook-backlog/replay-dead',
      headers: { authorization: authHeader(app), 'content-type': 'application/json' },
      payload: { event_type: [123, {}] },
    });
    expect(res.statusCode).toBe(400);
    expect(gateway.replayDeadWebhookBacklog).not.toHaveBeenCalled();
  });
});
