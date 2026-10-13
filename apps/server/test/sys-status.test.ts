import { describe, expect, it, vi } from 'vitest';
import { registerSysStatusRoute } from '../src/routes/sys-status.js';
import type { GatewayClient } from '../src/rest/gateway-client.js';
import type { KafkaTail } from '../src/kafka/tail.js';
import type { Broker } from '../src/broker/broker.js';

async function status(body: unknown, topics = ['cp.status']) {
  let handler!: () => Promise<unknown>;
  const app = {
    get: (_path: string, _opts: unknown, callback: typeof handler) => {
      handler = callback;
    },
  };
  await registerSysStatusRoute(app, {
    gateway: { health: vi.fn().mockResolvedValue(body) } as unknown as GatewayClient,
    kafka: { isRunning: () => true, subscribedTopics: () => topics } as unknown as KafkaTail,
    broker: { connectionCount: () => 1 } as unknown as Broker,
    startedAt: new Date('2026-10-13T10:00:00Z'),
  });
  return await handler();
}

describe('system observation health', () => {
  it('passes through the configured ClickHouse failure without treating degraded as healthy', async () => {
    expect(
      await status({
        status: 'degraded',
        components: {
          postgres: 'ok',
          redis: 'ok',
          clickhouse: 'error',
          clickhouse_error_class: 'ConnectionError',
        },
      }),
    ).toMatchObject({
      gateway: {
        ok: false,
        detail: 'status=degraded',
        components: { clickhouse: 'error', clickhouse_error_class: 'ConnectionError' },
      },
    });
  });

  it('does not call an idle Kafka consumer healthy when no topics were subscribed', async () => {
    expect(await status({ status: 'ok' }, [])).toMatchObject({
      kafka: {
        ok: false,
        consumer_running: true,
        topics: [],
        detail: 'consumer has no subscribed topics',
      },
    });
  });
});
