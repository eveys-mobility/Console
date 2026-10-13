// Subscription broker. Holds per-connection subscription state and translates
// Kafka events into deltas for the connections that care.

import { randomUUID } from 'node:crypto';

import type { Logger } from '../logger.js';
import type { KafkaEvent, KafkaTail } from '../kafka/tail.js';
import type { GatewayClient } from '../rest/gateway-client.js';
import { mergeConnectorFromStatusEvent, resolveQuery } from './queries.js';
import type { Delta, Snapshot, Subscription, SubscriptionError } from './types.js';
import { applySubscriptionDelta, type QueryName, type QueryParams } from '@eveys-console/protocol';

export type DeliveryHandler = (subscriptionId: string, delta: Delta | SubscriptionError) => void;

interface ConnectionState {
  connectionId: string;
  subscriptions: Map<string, Subscription>;
  deliver: DeliveryHandler;
}

export class Broker {
  private readonly connections = new Map<string, ConnectionState>();
  private detachKafka: (() => void) | null = null;

  constructor(
    private readonly kafka: KafkaTail,
    private readonly gateway: GatewayClient,
    private readonly log: Logger,
  ) {}

  start() {
    if (this.detachKafka) return;
    this.detachKafka = this.kafka.on(this.onKafkaEvent);
  }

  stop() {
    this.detachKafka?.();
    this.detachKafka = null;
    this.connections.clear();
  }

  registerConnection(connectionId: string, deliver: DeliveryHandler) {
    this.connections.set(connectionId, {
      connectionId,
      subscriptions: new Map(),
      deliver,
    });
  }

  removeConnection(connectionId: string) {
    this.connections.delete(connectionId);
  }

  connectionCount(): number {
    return this.connections.size;
  }

  async subscribe(
    connectionId: string,
    query: QueryName,
    params: QueryParams,
  ): Promise<{ subscriptionId: string; snapshot: Snapshot }> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`unknown connection ${connectionId}`);

    const subscriptionId = randomUUID();
    const resolver = resolveQuery(query);
    const snapshot = await resolver.snapshot(params, this.gateway);
    if (this.connections.get(connectionId) !== conn)
      throw new Error('Connection closed during subscribe');
    const sub: Subscription = {
      id: subscriptionId,
      query,
      params,
      snapshot: snapshot.snapshot,
      sequence: 0,
      applied: new Map(),
      pendingStatus: new Map(),
      stoppedTransactions: new Set(),
    };
    conn.subscriptions.set(subscriptionId, sub);
    return { subscriptionId, snapshot };
  }

  unsubscribe(connectionId: string, subscriptionId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;
    return conn.subscriptions.delete(subscriptionId);
  }

  private onKafkaEvent = (event: KafkaEvent) => {
    // Each subscription can produce zero, one, or many deltas per
    // event (e.g. one MeterValues report → N deltas, one per sample).
    // Resolvers may be async (charge-points re-fetches the row from
    // the gateway). Run them in parallel; ignore individual failures
    // so one slow / failing resolver doesn't block deliveries to
    // other subscriptions.
    for (const conn of this.connections.values()) {
      for (const sub of conn.subscriptions.values()) {
        const resolver = resolveQuery(sub.query);
        const sequence = ++sub.sequence;
        const key =
          sub.query === 'charge-points' || sub.query === 'charge-point' ? event.cpId : null;
        // Keep in-flight status events even before a new charger has a fleet
        // row. The next completed refetch folds in every observed connector.
        if (
          event.topic === 'cp.status' &&
          key &&
          (sub.query === 'charge-points' || sub.params.cp_id === key)
        ) {
          const pending = sub.pendingStatus.get(key) ?? [];
          pending.push(event);
          sub.pendingStatus.set(key, pending);
        }
        const current = () =>
          this.connections.get(conn.connectionId) === conn &&
          conn.subscriptions.get(sub.id) === sub;
        void resolver
          .deltasFromEvent(sub.params, event, this.gateway)
          .then((deltas) => {
            if (
              !current() ||
              deltas.length === 0 ||
              (key && sequence < (sub.applied.get(key) ?? 0))
            )
              return;
            if (key) sub.applied.set(key, sequence);
            for (const raw of deltas) {
              let delta = raw;
              // Start and stop arrive on different topics. A transaction ID
              // is terminal after stop, even if its old start is delivered later.
              // This state lasts only for this active subscription.
              if (delta.delta.kind === 'transactions-active') {
                if (delta.delta.op === 'remove' && delta.delta.transaction_id !== undefined)
                  sub.stoppedTransactions.add(delta.delta.transaction_id);
                if (
                  delta.delta.op === 'upsert' &&
                  delta.delta.row &&
                  sub.stoppedTransactions.has(delta.delta.row.transaction_id)
                )
                  continue;
              }
              if (
                (delta.delta.kind === 'charge-point' || delta.delta.kind === 'charge-points') &&
                delta.delta.row
              ) {
                let row = delta.delta.row;
                for (const statusEvent of sub.pendingStatus.get(row.cp_id) ?? [])
                  row = mergeConnectorFromStatusEvent(row, statusEvent);
                delta = { ...delta, delta: { ...delta.delta, row } };
              }
              sub.snapshot = applySubscriptionDelta(sub.snapshot, delta.delta) ?? sub.snapshot;
              if (delta.delta.kind === 'charge-point' && sub.snapshot.kind === 'charge-point') {
                delta = { ...delta, delta: { ...delta.delta, row: sub.snapshot.row } };
              } else if (
                delta.delta.kind === 'charge-points' &&
                delta.delta.row &&
                sub.snapshot.kind === 'charge-points'
              ) {
                const incoming = delta.delta.row;
                delta = {
                  ...delta,
                  delta: {
                    ...delta.delta,
                    row: sub.snapshot.rows.find((row) => row.cp_id === incoming.cp_id) ?? incoming,
                  },
                };
              }
              try {
                conn.deliver(sub.id, delta);
              } catch (err) {
                this.log.warn({ err, connectionId: conn.connectionId }, 'broker.deliver_failed');
              }
            }
            if (key) sub.pendingStatus.delete(key);
          })
          .catch((err: unknown) => {
            if (!current() || (key && sequence < (sub.applied.get(key) ?? 0))) return;
            if (key) sub.applied.set(key, sequence);
            if (key) sub.pendingStatus.delete(key);
            this.log.warn(
              {
                errorClass: err instanceof Error ? err.name : 'unknown',
                connectionId: conn.connectionId,
                subscriptionId: sub.id,
                topic: event.topic,
              },
              'broker.resolver_failed',
            );
            try {
              conn.deliver(sub.id, {
                cursor: event.cursor,
                error: 'Gateway refresh failed. Showing last known data.',
              });
            } catch {
              this.log.warn({ connectionId: conn.connectionId }, 'broker.deliver_failed');
            }
          });
      }
    }
  };
}
