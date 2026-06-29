// Kafka tail. One consumer group per Console deployment; horizontal scaling is
// limited by the topics' partition counts (cp_id-keyed). Fan-out to per-conn
// subscriptions is handled by the broker.

import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';

import type { Config } from '../config.js';
import { decodeEnvelope } from './event-decoder.js';
import type { Logger } from '../logger.js';
import { recordKafkaMessage } from '../metrics/registry.js';

export interface KafkaEvent {
  topic: string;
  cpId: string | null;
  cursor: string;
  payload: unknown;
  timestamp: Date;
}

export type KafkaListener = (event: KafkaEvent) => void;

export class KafkaTail {
  private readonly consumer: Consumer;
  private readonly listeners = new Set<KafkaListener>();
  private running = false;
  private topics: string[] = [];

  isRunning(): boolean {
    return this.running;
  }

  subscribedTopics(): string[] {
    return [...this.topics];
  }

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    const kafka = new Kafka({
      clientId: cfg.KAFKA_CLIENT_ID,
      brokers: cfg.KAFKA_BROKERS,
    });
    this.consumer = kafka.consumer({ groupId: cfg.KAFKA_GROUP_ID });
  }

  async start() {
    if (this.running) return;
    await this.consumer.connect();
    const wanted = [
      this.cfg.KAFKA_TOPICS_BOOT,
      this.cfg.KAFKA_TOPICS_STATUS,
      this.cfg.KAFKA_TOPICS_METER,
      this.cfg.KAFKA_TOPICS_TX_STARTED,
      this.cfg.KAFKA_TOPICS_TX_STOPPED,
      this.cfg.KAFKA_TOPICS_CONNECTED,
      this.cfg.KAFKA_TOPICS_DISCONNECTED,
      this.cfg.KAFKA_TOPICS_DIAGNOSTICS_STATUS,
      this.cfg.KAFKA_TOPICS_FIRMWARE_STATUS,
    ];
    // Subscribe one topic at a time so a missing topic on the broker
    // (UNKNOWN_TOPIC_OR_PARTITION on laptop dev where the gateway hasn't
    // created every topic yet) doesn't fail the whole startup. We log
    // and continue; /sys/status reports what we ended up subscribed to.
    const subscribed: string[] = [];
    const skipped: { topic: string; reason: string }[] = [];
    for (const t of wanted) {
      try {
        await this.consumer.subscribe({ topic: t, fromBeginning: false });
        subscribed.push(t);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        skipped.push({ topic: t, reason });
        this.log.warn({ topic: t, err: reason }, 'kafka.subscribe.skipped');
      }
    }
    this.topics = subscribed;
    this.log.info({ topics: subscribed, skipped }, 'kafka.subscribed');

    if (subscribed.length > 0) {
      await this.consumer.run({ eachMessage: this.handle });
    } else {
      this.log.warn(
        'kafka.no_topics: every configured topic was missing on the broker; consumer idle',
      );
    }
    this.running = true;
  }

  async stop() {
    if (!this.running) return;
    await this.consumer.disconnect();
    this.running = false;
  }

  on(listener: KafkaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handle = async ({ topic, partition, message }: EachMessagePayload) => {
    if (!message.value) return;
    // Topic is one of the four configured KAFKA_TOPICS_* — bounded label set.
    recordKafkaMessage(topic);
    // The gateway publishes protobuf-encoded `eveys.events.v1.EventEnvelope`
    // on every topic. Decode here so listeners receive the `payload` branch
    // of the oneof (cp_boot / cp_status / cp_meter / tx_started / …) as a
    // plain object, not raw bytes.
    let envelope;
    try {
      envelope = decodeEnvelope(Buffer.from(message.value));
    } catch (err) {
      this.log.warn({ topic, partition, err }, 'kafka.envelope_decode_failed');
      return;
    }
    const cpId = envelope.cp_id || message.key?.toString('utf8') || null;
    const cursor = `k:${topic}:${partition}:${message.offset}`;
    const event: KafkaEvent = {
      topic,
      cpId,
      cursor,
      // Forward the decoded oneof branch as the payload — that's the row
      // shape the broker resolvers want (e.g. the `tx_started` payload
      // for tx.started messages).
      payload: envelope.payload,
      timestamp: new Date(Number(message.timestamp)),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err, topic }, 'kafka.listener_threw');
      }
    }
  };
}
