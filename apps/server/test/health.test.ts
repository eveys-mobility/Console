import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerHealthRoutes } from '../src/routes/health.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});
async function fixture({
  running = true,
  topics = ['cp.status'],
  health = async (_signal?: AbortSignal) => ({
    status: 'ok',
    components: { postgres: 'ok', redis: 'ok', clickhouse: 'ok', ingestor: 'unknown' },
  }),
}: {
  running?: boolean;
  topics?: string[];
  health?: (signal?: AbortSignal) => Promise<unknown>;
} = {}) {
  const app = Fastify();
  apps.push(app);
  await registerHealthRoutes(app, {
    kafka: { isRunning: () => running, subscribedTopics: () => topics },
    gateway: { health },
  });
  return app;
}

describe('process liveness and observation readiness', () => {
  it('keeps process liveness healthy without checking any upstream', async () => {
    const health = vi.fn().mockRejectedValue(new Error('upstream failed'));
    const app = await fixture({ running: false, topics: [], health });
    const response = await app.inject('/healthz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(health).not.toHaveBeenCalled();
  });
  it.each([
    { running: false, topics: ['cp.status'] },
    { running: true, topics: [] },
  ])('reports idle/stopped Kafka unready without changing liveness', async (kafka) => {
    const app = await fixture(kafka);
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, components: { kafka: { ok: false } } });
  });
  it('reports a gateway 500 as unavailable without exposing the raw error', async () => {
    const app = await fixture({
      health: async () => {
        throw new Error('upstream 500 private detail');
      },
    });
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      components: { gateway: { ok: false, status: 'unavailable' } },
    });
    expect(response.body).not.toContain('private detail');
  });
  it('keeps Console available to inspect a degraded archive when gateway core is healthy', async () => {
    const app = await fixture({
      health: async () => ({
        status: 'degraded',
        components: { postgres: 'ok', redis: 'ok', clickhouse: 'error', ingestor: 'unknown' },
      }),
    });
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      components: {
        gateway: {
          ok: true,
          status: 'degraded',
          components: { clickhouse: 'error', ingestor: 'unknown' },
        },
      },
    });
  });
  it('does not call a failed gateway core ready', async () => {
    const app = await fixture({
      health: async () => ({
        status: 'degraded',
        components: { postgres: 'error', redis: 'ok', clickhouse: 'ok' },
      }),
    });
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      components: { gateway: { ok: false, status: 'degraded' } },
    });
  });
  it.each([
    { status: 'ok', components: { postgres: 'error', redis: 'ok' } },
    { status: 'ok', components: { postgres: 'ok', redis: 'error' } },
    { status: 'ok' },
    { status: 'ok', components: null },
    { status: 'ok', components: [] },
    { status: 'ok', components: { postgres: true, redis: 'ok' } },
    { status: 'ok', components: { postgres: 'ok' } },
    { status: 'degraded', components: { postgres: 'ok' } },
    { status: 'unknown', components: { postgres: 'ok', redis: 'ok' } },
    { components: { postgres: 'ok', redis: 'ok' } },
    null,
  ])('fails closed for an unhealthy or malformed gateway core response: %j', async (body) => {
    const app = await fixture({ health: async () => body });
    const response = await app.inject('/readyz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      components: { gateway: { ok: false } },
    });
  });
  it('returns ready only for running subscribed Kafka and healthy gateway', async () => {
    const response = await (await fixture()).inject('/readyz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      components: { kafka: { ok: true }, gateway: { ok: true, status: 'ok' } },
    });
  });
  it('bounds an unresponsive gateway probe and aborts its transport', async () => {
    let signal: AbortSignal | undefined;
    const app = await fixture({
      health: async (candidate) => {
        signal = candidate;
        return new Promise(() => {});
      },
    });
    await app.ready();
    vi.useFakeTimers();
    const pending = app.inject('/readyz');
    await vi.advanceTimersByTimeAsync(1100);
    const response = await pending;
    expect(response.statusCode).toBe(503);
    expect(signal?.aborted).toBe(true);
    expect(response.json()).toMatchObject({ components: { gateway: { status: 'unavailable' } } });
  });
});
