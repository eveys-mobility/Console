// Broker tests using a fake Kafka tail + fake gateway client. The broker
// depends only on a structural subset of each (a `.on(listener)` and
// `.listChargePoints()` / `.getChargePoint()` / `.listActiveTransactions()`),
// so we type the fakes as the same class shape via `as unknown as`.
//
// The broker's `onKafkaEvent` runs resolvers asynchronously, so each
// test emits an event and then awaits a microtask flush before asserting
// on the deliver mock.

import { describe, expect, it, vi } from 'vitest';

import { Broker } from '../src/broker/broker.js';
import type { GatewayClient } from '../src/rest/gateway-client.js';
import type { KafkaEvent, KafkaListener, KafkaTail } from '../src/kafka/tail.js';
import type { Logger } from '../src/logger.js';

class FakeKafka {
  private listeners = new Set<KafkaListener>();
  on(l: KafkaListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(event: KafkaEvent) {
    for (const l of this.listeners) l(event);
  }
}

interface FakeGatewayOptions {
  online?: boolean;
  vendor?: string;
  last_status?: string;
  connectors?: Array<{
    connector_id: number;
    status: string;
    error_code: string | null;
    last_changed_at: string | null;
  }>;
}

function makeFakeGateway(opts: FakeGatewayOptions = {}) {
  const listSpy = vi.fn().mockResolvedValue({ charge_points: [] });
  const getSpy = vi.fn(async (cpId: string) => ({
    cp_id: cpId,
    online: opts.online ?? true,
    pod_id: 'pod-1',
    vendor: opts.vendor ?? 'ACME',
    model: 'X1',
    firmware_version: '1.0',
    serial_number: 'SN1',
    last_boot_at: null,
    last_heartbeat_at: null,
    last_status: opts.last_status ?? 'Available',
    last_seen_seq: 0,
    connectors: opts.connectors ?? [],
  }));
  const gw = {
    listChargePoints: listSpy,
    getChargePoint: getSpy,
    listActiveTransactions: vi.fn().mockResolvedValue({ transactions: [] }),
    remoteStart: vi.fn(),
    remoteStop: vi.fn(),
    reset: vi.fn(),
  };
  return {
    client: gw as unknown as GatewayClient,
    listSpy,
    getSpy,
  };
}

function fakeGateway(opts: FakeGatewayOptions = {}): GatewayClient {
  return makeFakeGateway(opts).client;
}

const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => silentLog,
} as unknown as Logger;

// Yield to the microtask queue so async resolvers settle and the broker
// has called `deliver` before we assert. setImmediate ⇒ "after all
// pending microtasks". Two-pass for resolvers that await two promises
// (e.g. the cp re-fetch + the deliver loop).
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Broker — subscribe and snapshot', () => {
  it('returns a snapshot for a charge-point subscription', async () => {
    const broker = new Broker(new FakeKafka() as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    broker.registerConnection('c1', vi.fn());

    const { subscriptionId, snapshot } = await broker.subscribe('c1', 'charge-point', {
      cp_id: 'CP_A',
    });

    expect(subscriptionId).toBeTruthy();
    expect(snapshot.snapshot.kind).toBe('charge-point');
    if (snapshot.snapshot.kind === 'charge-point') {
      expect(snapshot.snapshot.row.cp_id).toBe('CP_A');
    }
  });
});

describe('Broker — charge-point (single) deltas', () => {
  it('retains both connectors when a new fleet row has concurrent first status refetches', async () => {
    const kafka = new FakeKafka();
    const { client, getSpy } = makeFakeGateway();
    const initial = await getSpy('NEW');
    const broker = new Broker(kafka as unknown as KafkaTail, client, silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});
    let finishOld!: (row: typeof initial) => void;
    getSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    getSpy.mockResolvedValueOnce(initial);
    kafka.emit({
      topic: 'cp.status',
      cpId: 'NEW',
      cursor: 'one',
      timestamp: new Date('2026-10-13T10:00:00Z'),
      payload: { connectorId: 1, status: 'Charging' },
    });
    kafka.emit({
      topic: 'cp.status',
      cpId: 'NEW',
      cursor: 'two',
      timestamp: new Date('2026-10-13T10:01:00Z'),
      payload: { connectorId: 2, status: 'Charging' },
    });
    await flushAsync();
    finishOld(initial);
    await flushAsync();
    expect(
      deliver.mock.calls
        .at(-1)?.[1]
        .delta.row.connectors.map((c: { connector_id: number }) => c.connector_id),
    ).toEqual([1, 2]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('shows a connector status event in detail even when the gateway archive is empty', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ connectors: [] }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'A' });
    kafka.emit({
      topic: 'cp.status',
      cpId: 'A',
      cursor: '1',
      timestamp: new Date('2026-10-13T10:00:00Z'),
      payload: { connectorId: 2, status: 'Charging', errorCode: 'NoError' },
    });
    await flushAsync();
    expect(deliver.mock.calls[0]?.[1].delta.row.connectors).toEqual([
      {
        connector_id: 2,
        status: 'Charging',
        error_code: 'NoError',
        last_changed_at: '2026-10-13T10:00:00.000Z',
      },
    ]);
  });

  it('retains both live connectors across status and boot refetches', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ connectors: [] }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'A' });
    for (const id of [1, 2]) {
      kafka.emit({
        topic: 'cp.status',
        cpId: 'A',
        cursor: String(id),
        timestamp: new Date(`2026-10-13T10:0${id}:00Z`),
        payload: { connectorId: id, status: 'Charging' },
      });
      await flushAsync();
    }
    kafka.emit({
      topic: 'cp.boot',
      cpId: 'A',
      cursor: '3',
      timestamp: new Date('2026-10-13T10:03:00Z'),
      payload: {},
    });
    await flushAsync();
    expect(
      deliver.mock.calls
        .at(-1)?.[1]
        .delta.row.connectors.map((c: { connector_id: number }) => c.connector_id),
    ).toEqual([1, 2]);
  });

  it('drops an older refetch completing after a newer event', async () => {
    const kafka = new FakeKafka();
    const { client, getSpy } = makeFakeGateway();
    const initial = await getSpy('A');
    const broker = new Broker(kafka as unknown as KafkaTail, client, silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'A' });
    let finishOld!: (row: typeof initial) => void;
    getSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    getSpy.mockResolvedValueOnce({ ...initial, last_status: 'Charging' });
    kafka.emit({
      topic: 'cp.status',
      cpId: 'A',
      cursor: 'old',
      timestamp: new Date('2026-10-13T10:00:00Z'),
      payload: { connectorId: 1, status: 'Available' },
    });
    kafka.emit({
      topic: 'cp.status',
      cpId: 'A',
      cursor: 'new',
      timestamp: new Date('2026-10-13T10:01:00Z'),
      payload: { connectorId: 1, status: 'Charging' },
    });
    await flushAsync();
    finishOld(initial);
    await flushAsync();
    expect(deliver.mock.calls.at(-1)?.[1].delta.row.connectors[0].status).toBe('Charging');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('reports a refetch failure to the subscription without exposing the upstream message', async () => {
    const kafka = new FakeKafka();
    const { client, getSpy } = makeFakeGateway();
    const broker = new Broker(kafka as unknown as KafkaTail, client, silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'A' });
    getSpy.mockRejectedValueOnce(new Error('sensitive upstream payload'));
    kafka.emit({
      topic: 'cp.status',
      cpId: 'A',
      cursor: 'error',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Charging' },
    });
    await flushAsync();
    expect(deliver.mock.calls.at(-1)?.[1]).toMatchObject({
      error: 'Gateway refresh failed. Showing last known data.',
    });
    expect(JSON.stringify(deliver.mock.calls)).not.toContain('sensitive upstream');
  });
  it('delivers a delta when a status event arrives for the subscribed cp', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_A',
      cursor: 'k:cp.status:0:1',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Charging', errorCode: 'NoError' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, delta] = deliver.mock.calls[0]!;
    expect(delta.cursor).toBe('k:cp.status:0:1');
    expect(delta.delta.kind).toBe('charge-point');
    // The resolver re-fetches the row from the gateway; cp_id must
    // match the event's cp_id (the param). The fake gateway echoes it.
    expect(delta.delta.row.cp_id).toBe('CP_A');
  });

  it('does not deliver when the event is for a different cp_id', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_B',
      cursor: 'k:cp.status:0:2',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    const { subscriptionId } = await broker.subscribe('c1', 'charge-point', {
      cp_id: 'CP_A',
    });
    broker.unsubscribe('c1', subscriptionId);

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_A',
      cursor: 'k:cp.status:0:3',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('isolates subscriptions across connections', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliverA = vi.fn();
    const deliverB = vi.fn();
    broker.registerConnection('cA', deliverA);
    broker.registerConnection('cB', deliverB);
    await broker.subscribe('cA', 'charge-point', { cp_id: 'CP_X' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_X',
      cursor: 'k:cp.status:0:4',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    expect(deliverA).toHaveBeenCalledOnce();
    expect(deliverB).not.toHaveBeenCalled();
  });

  it('clears subscriptions on connection drop', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });
    broker.removeConnection('c1');

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_A',
      cursor: 'k:cp.status:0:5',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('Broker — active transaction stop', () => {
  it.each([true, false])(
    'does not reopen a stopped transaction after a late start (settled stop: %s)',
    async (settleStop) => {
      const kafka = new FakeKafka();
      const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
      broker.start();
      const deliver = vi.fn();
      broker.registerConnection('c1', deliver);
      await broker.subscribe('c1', 'transactions-active', {});
      kafka.emit({
        topic: 'tx.stopped',
        cpId: 'CP_A',
        cursor: 'stop',
        timestamp: new Date('2026-10-13T10:02:00Z'),
        payload: { transactionId: 7 },
      });
      if (settleStop) await flushAsync();
      kafka.emit({
        topic: 'tx.started',
        cpId: 'CP_A',
        cursor: 'late-start',
        timestamp: new Date('2026-10-13T10:01:00Z'),
        payload: { transactionId: 7 },
      });
      kafka.emit({
        topic: 'tx.started',
        cpId: 'CP_A',
        cursor: 'new-start',
        timestamp: new Date('2026-10-13T10:03:00Z'),
        payload: { transactionId: 8 },
      });
      await flushAsync();
      expect(deliver.mock.calls.map(([, delivery]) => delivery.delta)).toEqual([
        { kind: 'transactions-active', op: 'remove', transaction_id: 7 },
        expect.objectContaining({
          kind: 'transactions-active',
          op: 'upsert',
          row: expect.objectContaining({ transaction_id: 8 }),
        }),
      ]);
    },
  );

  it('emits a remove when the active transaction stops', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'transactions-active', {});
    kafka.emit({
      topic: 'tx.stopped',
      cpId: 'A',
      cursor: 'stop',
      timestamp: new Date(),
      payload: { transactionId: 7 },
    });
    await flushAsync();
    expect(deliver.mock.calls.at(-1)?.[1].delta).toEqual({
      kind: 'transactions-active',
      op: 'remove',
      transaction_id: 7,
    });
  });
});

describe('Broker — charge-points (list) deltas', () => {
  it('emits an upsert when a status event arrives', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_X',
      cursor: 'k:cp.status:0:9',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Charging', errorCode: 'NoError' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-points');
    expect(d.delta.op).toBe('upsert');
    expect(d.delta.row.cp_id).toBe('CP_X');
  });

  it('emits remove when the row no longer matches an online=true filter', async () => {
    const kafka = new FakeKafka();
    // Gateway returns online=false; subscription filter is online=true.
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: false }),
      silentLog,
    );
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { online: true });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_Y',
      cursor: 'k:cp.status:0:10',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
    expect(d.delta.cp_id).toBe('CP_Y');
  });

  it('emits remove when the row no longer matches a vendor filter', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ vendor: 'ACME' }),
      silentLog,
    );
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { vendor: 'OTHER' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_Z',
      cursor: 'k:cp.status:0:11',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
  });

  it('forwards last_status + cp_id_contains + page + page_size to the gateway on snapshot', async () => {
    const kafka = new FakeKafka();
    const { client, listSpy } = makeFakeGateway();
    listSpy.mockResolvedValueOnce({
      charge_points: [],
      pagination: { page: 2, page_size: 50, total: 873 },
    });
    const broker = new Broker(kafka as unknown as KafkaTail, client, silentLog);
    broker.start();
    broker.registerConnection('c1', vi.fn());
    const { snapshot } = await broker.subscribe('c1', 'charge-points', {
      last_status: 'Charging',
      cp_id_contains: '617b5675',
      page: 2,
      page_size: 50,
    });

    expect(listSpy).toHaveBeenCalledOnce();
    expect(listSpy.mock.calls[0][0]).toEqual({
      last_status: 'Charging',
      cp_id_contains: '617b5675',
      page: 2,
      page_size: 50,
    });
    // Server's pagination block flows into the snapshot.
    if (snapshot.snapshot.kind === 'charge-points') {
      expect(snapshot.snapshot.total).toBe(873);
      expect(snapshot.snapshot.page).toBe(2);
      expect(snapshot.snapshot.page_size).toBe(50);
    }
  });

  it('emits remove when the cp_id does not match cp_id_contains', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { cp_id_contains: '617b' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'cp_other_id',
      cursor: 'k:cp.status:0:90',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Available' },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
  });

  it('emits remove when the row no longer matches a last_status filter', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ last_status: 'Available' }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { last_status: 'Charging' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_S',
      cursor: 'k:cp.status:0:12',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Available' },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
    expect(d.delta.cp_id).toBe('CP_S');
  });

  it('emits remove when the cp_id does not match cp_id_prefix', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { cp_id_prefix: 'cp_77' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'cp_99_other',
      cursor: 'k:cp.status:0:13',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Available' },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
  });

  it('merges the cp.status event payload into row.connectors so the UI sees the fresh status before ClickHouse catches up', async () => {
    const kafka = new FakeKafka();
    // Gateway returns an empty connectors[] (the ingestor race we
    // are trying to defend against). The event payload should be
    // synthesised into the delivered row.
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ connectors: [] }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_M',
      cursor: 'k:cp.status:0:14',
      timestamp: new Date('2026-05-11T10:00:00Z'),
      payload: {
        connectorId: 2,
        status: 'Charging',
        errorCode: 'NoError',
        chargerReportedAt: '2026-05-11T09:59:55Z',
      },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('upsert');
    expect(d.delta.row.connectors).toEqual([
      {
        connector_id: 2,
        status: 'Charging',
        error_code: 'NoError',
        last_changed_at: '2026-05-11T09:59:55Z',
      },
    ]);
  });

  it('does not overwrite a fresher connector entry from the gateway with an older cp.status event', async () => {
    const kafka = new FakeKafka();
    // Gateway already knows connector 1 is Charging as of t+1m.
    // An older status event (t+0) arrives — should not regress it.
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({
        connectors: [
          {
            connector_id: 1,
            status: 'Charging',
            error_code: null,
            last_changed_at: '2026-05-11T10:01:00Z',
          },
        ],
      }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_M',
      cursor: 'k:cp.status:0:15',
      timestamp: new Date('2026-05-11T10:01:30Z'),
      payload: {
        connectorId: 1,
        status: 'Preparing',
        errorCode: 'NoError',
        chargerReportedAt: '2026-05-11T10:00:00Z',
      },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.row.connectors[0]).toMatchObject({
      connector_id: 1,
      status: 'Charging',
      last_changed_at: '2026-05-11T10:01:00Z',
    });
  });

  it('emits an upsert when a cp.connected event arrives (online flips live)', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: true }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});

    kafka.emit({
      topic: 'cp.connected',
      cpId: 'CP_CONN',
      cursor: 'k:cp.connected:0:1',
      timestamp: new Date(),
      payload: { subprotocol: 'ocpp1.6', pod_id: 'pod-a' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-points');
    expect(d.delta.op).toBe('upsert');
    expect(d.delta.row.cp_id).toBe('CP_CONN');
    expect(d.delta.row.online).toBe(true);
  });

  it('emits an upsert when a cp.disconnected event arrives (offline flips live)', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: false }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', {});

    kafka.emit({
      topic: 'cp.disconnected',
      cpId: 'CP_DROP',
      cursor: 'k:cp.disconnected:0:1',
      timestamp: new Date(),
      payload: { pod_id: 'pod-a', reason: 'clean' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-points');
    expect(d.delta.op).toBe('upsert');
    expect(d.delta.row.online).toBe(false);
  });

  it('removes a row when cp.disconnected arrives and online=true filter is active', async () => {
    // The list page can be filtered to "online only"; a charger that
    // just dropped should disappear immediately, not wait for the next
    // status event.
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: false }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-points', { online: true });

    kafka.emit({
      topic: 'cp.disconnected',
      cpId: 'CP_X',
      cursor: 'k:cp.disconnected:0:2',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.op).toBe('remove');
    expect(d.delta.cp_id).toBe('CP_X');
  });
});

describe('Broker — charge-point (single) presence deltas', () => {
  it('emits a row delta on cp.connected for the subscribed cp_id', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: true }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.connected',
      cpId: 'CP_A',
      cursor: 'k:cp.connected:0:5',
      timestamp: new Date(),
      payload: { subprotocol: 'ocpp1.6', pod_id: 'pod-x' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-point');
    expect(d.delta.row.online).toBe(true);
  });

  it('ignores presence events for other cp_ids', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.disconnected',
      cpId: 'CP_B',
      cursor: 'k:cp.disconnected:0:6',
      timestamp: new Date(),
      payload: {},
    });
    await flushAsync();
    expect(deliver).not.toHaveBeenCalled();
  });
});

// Without these subscriptions the detail page's diagnostics + firmware
// status chips stay stuck on whatever the initial snapshot held — the
// gateway records new values but the Console never re-fetches the row
// to surface them. See #173 for the original repro.
describe('Broker — charge-point diagnostics/firmware status deltas', () => {
  it('re-fetches the row on cp.diagnostics_status for the subscribed cp_id', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: true }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.diagnostics_status',
      cpId: 'CP_A',
      cursor: 'k:cp.diagnostics_status:0:1',
      timestamp: new Date(),
      payload: { status: 'Uploading' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-point');
    expect(d.delta.row.cp_id).toBe('CP_A');
  });

  it('re-fetches the row on cp.firmware_status for the subscribed cp_id', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(
      kafka as unknown as KafkaTail,
      fakeGateway({ online: true }),
      silentLog,
    );
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.firmware_status',
      cpId: 'CP_A',
      cursor: 'k:cp.firmware_status:0:1',
      timestamp: new Date(),
      payload: { status: 'Downloaded' },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('charge-point');
  });

  it('ignores diagnostics/firmware status events for other cp_ids', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();
    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'charge-point', { cp_id: 'CP_A' });

    kafka.emit({
      topic: 'cp.diagnostics_status',
      cpId: 'CP_B',
      cursor: 'k:cp.diagnostics_status:0:2',
      timestamp: new Date(),
      payload: { status: 'Uploaded' },
    });
    kafka.emit({
      topic: 'cp.firmware_status',
      cpId: 'CP_B',
      cursor: 'k:cp.firmware_status:0:2',
      timestamp: new Date(),
      payload: { status: 'Installed' },
    });
    await flushAsync();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('Broker — transactions-active deltas', () => {
  it('decodes a tx.started payload into a transaction summary', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'transactions-active', {});

    kafka.emit({
      topic: 'tx.started',
      cpId: 'CP_T',
      cursor: 'k:tx.started:0:1',
      timestamp: new Date(),
      // protobufjs decodes proto3 snake_case to camelCase.
      payload: {
        transactionId: 42,
        connectorId: 1,
        idTag: 'TAG-001',
        meterStartWh: 100,
        chargerReportedAt: '2026-01-01T12:00:00Z',
      },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('transactions-active');
    expect(d.delta.op).toBe('upsert');
    expect(d.delta.row).toMatchObject({
      transaction_id: 42,
      cp_id: 'CP_T',
      connector_id: 1,
      id_tag: 'TAG-001',
      meter_start_wh: 100,
      meter_stop_wh: null,
      consumed_wh: null,
      started_reported_at: '2026-01-01T12:00:00Z',
      stopped_reported_at: null,
      stop_reason: null,
    });
  });
});

describe('Broker — meter-history deltas', () => {
  it('emits one delta per sampled value in a cp.meter event', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'meter-history', { cp_id: 'CP_M' });

    kafka.emit({
      topic: 'cp.meter',
      cpId: 'CP_M',
      cursor: 'k:cp.meter:0:1',
      timestamp: new Date(),
      payload: {
        connectorId: 1,
        transactionId: 7,
        chargerReportedAt: '2026-01-01T12:00:00Z',
        sampledValues: [
          { value: '1234.5', measurand: 'MEASURAND_VOLTAGE', unit: 'UNIT_V' },
          { value: '230', measurand: 'MEASURAND_CURRENT_IMPORT', unit: 'UNIT_A' },
          {
            value: '5000',
            measurand: 'MEASURAND_ENERGY_ACTIVE_IMPORT_REGISTER',
            unit: 'UNIT_WH',
          },
        ],
      },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledTimes(3);
    const calls = deliver.mock.calls.map((c) => c[1].delta);
    expect(calls[0]).toMatchObject({
      kind: 'meter-history',
      append: {
        cp_id: 'CP_M',
        transaction_id: 7,
        connector_id: 1,
        measurand: 'VOLTAGE',
        value: 1234.5,
        unit: 'V',
        recorded_at: '2026-01-01T12:00:00Z',
      },
    });
    expect(calls[1].append.measurand).toBe('CURRENT_IMPORT');
    expect(calls[2].append.measurand).toBe('ENERGY_ACTIVE_IMPORT_REGISTER');
  });

  it('skips samples with non-numeric values', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'meter-history', { cp_id: 'CP_M' });

    kafka.emit({
      topic: 'cp.meter',
      cpId: 'CP_M',
      cursor: 'k:cp.meter:0:2',
      timestamp: new Date(),
      payload: {
        connectorId: 1,
        sampledValues: [{ value: 'not-a-number' }, { value: '42' }, { value: null }],
      },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.append.value).toBe(42);
  });

  it('ignores meter events for a different cp_id', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'meter-history', { cp_id: 'CP_M' });

    kafka.emit({
      topic: 'cp.meter',
      cpId: 'CP_OTHER',
      cursor: 'k:cp.meter:0:3',
      timestamp: new Date(),
      payload: { connectorId: 1, sampledValues: [{ value: '1' }] },
    });
    await flushAsync();

    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('Broker — status-history deltas', () => {
  it('emits a status delta with mapped fields', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'status-history', { cp_id: 'CP_S' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_S',
      cursor: 'k:cp.status:0:1',
      timestamp: new Date(),
      payload: {
        connectorId: 2,
        status: 'Faulted',
        errorCode: 'GroundFailure',
        info: 'detected at boot',
        chargerReportedAt: '2026-01-01T12:00:00Z',
      },
    });
    await flushAsync();

    expect(deliver).toHaveBeenCalledOnce();
    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.kind).toBe('status-history');
    expect(d.delta.append).toMatchObject({
      cp_id: 'CP_S',
      connector_id: 2,
      status: 'Faulted',
      error_code: 'GroundFailure',
      info: 'detected at boot',
      reported_at: '2026-01-01T12:00:00Z',
    });
  });

  it('treats empty error_code/info as null', async () => {
    const kafka = new FakeKafka();
    const broker = new Broker(kafka as unknown as KafkaTail, fakeGateway(), silentLog);
    broker.start();

    const deliver = vi.fn();
    broker.registerConnection('c1', deliver);
    await broker.subscribe('c1', 'status-history', { cp_id: 'CP_S' });

    kafka.emit({
      topic: 'cp.status',
      cpId: 'CP_S',
      cursor: 'k:cp.status:0:2',
      timestamp: new Date(),
      payload: { connectorId: 1, status: 'Available', errorCode: '', info: '' },
    });
    await flushAsync();

    const [, d] = deliver.mock.calls[0]!;
    expect(d.delta.append.error_code).toBeNull();
    expect(d.delta.append.info).toBeNull();
  });
});
