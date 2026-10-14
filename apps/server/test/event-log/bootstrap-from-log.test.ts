// When the event log is configured, the device-events resolver's
// snapshot() returns up to bootstrapLimit recent events for the
// cp_id rather than an empty list. Drives the writer to seed
// fixtures so the on-disk shape stays in one place.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configureEventLogReader,
  resetEventLogReader,
  resolveQuery,
} from '../../src/broker/queries.js';
import { EventLogWriter } from '../../src/event-log/writer.js';
import type { KafkaEvent } from '../../src/kafka/tail.js';
import type { Logger } from '../../src/logger.js';
import type { GatewayClient } from '../../src/rest/gateway-client.js';

const gateway = {} as unknown as GatewayClient;
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as unknown as Logger;

let root = '';
let writer: EventLogWriter;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'evlog-bootstrap-'));
  writer = new EventLogWriter({ root, fsyncIntervalMs: 0, logger });
});
afterEach(async () => {
  await writer.close();
  await fs.rm(root, { recursive: true, force: true });
  resetEventLogReader();
});

function statusEvent(iso: string, cpId = 'CP_A'): KafkaEvent {
  return {
    topic: 'cp.status',
    cpId,
    cursor: `k:cp.status:0:${iso}`,
    timestamp: new Date(iso),
    payload: { connectorId: 1, status: 'Charging', errorCode: 'NoError' },
  };
}

describe('device-events bootstrap from log', () => {
  it('marks a failed archive read unavailable without preventing live subscription', async () => {
    // A file where the CP directory belongs yields a real ENOTDIR read failure.
    await fs.writeFile(path.join(root, 'CP_BROKEN'), 'not a directory');
    configureEventLogReader({ root, bootstrapLimit: 10 });
    const resolver = resolveQuery('device-events');
    const snap = await resolver.snapshot({ cp_id: 'CP_BROKEN' }, gateway);
    expect(snap.snapshot).toMatchObject({
      kind: 'device-events',
      rows: [],
      history_state: 'unavailable',
      history_error: 'read_failed',
    });
    expect(
      await resolver.deltasFromEvent(
        { cp_id: 'CP_BROKEN' },
        statusEvent('2026-10-13T07:00:00Z', 'CP_BROKEN'),
        gateway,
      ),
    ).toHaveLength(1);
  });

  it('marks disabled history unconfigured rather than claiming an empty archive', async () => {
    resetEventLogReader();
    expect(
      (await resolveQuery('device-events').snapshot({ cp_id: 'CP_A' }, gateway)).snapshot,
    ).toMatchObject({
      history_state: 'unconfigured',
      history_error: null,
    });
  });
  it('returns up to bootstrapLimit recent events for the requested cp_id', async () => {
    for (let i = 0; i < 5; i++) {
      const sec = String(i).padStart(2, '0');
      await writer.appendFromKafka(statusEvent(`2026-05-11T12:00:${sec}Z`));
    }
    await writer.flush();
    configureEventLogReader({ root, bootstrapLimit: 3 });

    const resolver = resolveQuery('device-events');
    const snap = await resolver.snapshot({ cp_id: 'CP_A' }, gateway);
    expect(snap.snapshot.kind).toBe('device-events');
    if (snap.snapshot.kind === 'device-events') {
      expect(snap.snapshot.rows).toHaveLength(3);
      // newest first
      expect(snap.snapshot.rows[0]!.at).toBe('2026-05-11T12:00:04.000Z');
    }
  });

  it('falls back to empty rows when the cp has no log entries', async () => {
    configureEventLogReader({ root, bootstrapLimit: 10 });
    const resolver = resolveQuery('device-events');
    const snap = await resolver.snapshot({ cp_id: 'CP_NEW' }, gateway);
    if (snap.snapshot.kind === 'device-events') {
      expect(snap.snapshot.rows).toEqual([]);
      expect(snap.snapshot).toMatchObject({ history_state: 'available', history_error: null });
    }
  });

  it('does not cross-contaminate cp_ids', async () => {
    await writer.appendFromKafka(statusEvent('2026-05-11T12:00:00Z', 'CP_A'));
    await writer.appendFromKafka(statusEvent('2026-05-11T12:00:01Z', 'CP_B'));
    await writer.flush();
    configureEventLogReader({ root, bootstrapLimit: 10 });

    const resolver = resolveQuery('device-events');
    const snapA = await resolver.snapshot({ cp_id: 'CP_A' }, gateway);
    const snapB = await resolver.snapshot({ cp_id: 'CP_B' }, gateway);
    if (snapA.snapshot.kind === 'device-events' && snapB.snapshot.kind === 'device-events') {
      expect(snapA.snapshot.rows).toHaveLength(1);
      expect(snapB.snapshot.rows).toHaveLength(1);
      expect(snapA.snapshot.rows[0]!.at).toBe('2026-05-11T12:00:00.000Z');
      expect(snapB.snapshot.rows[0]!.at).toBe('2026-05-11T12:00:01.000Z');
    }
  });
});
