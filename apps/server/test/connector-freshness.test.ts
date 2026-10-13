import { describe, expect, it } from 'vitest';
import type { ChargePointSummary } from '@eveys-console/protocol';
import { mergeConnectorFromStatusEvent, resolveQuery } from '../src/broker/queries.js';
import type { KafkaEvent } from '../src/kafka/tail.js';
import type { GatewayClient } from '../src/rest/gateway-client.js';

const row = (): ChargePointSummary => ({
  cp_id: 'CP_TEST',
  online: true,
  pod_id: 'test',
  vendor: null,
  model: null,
  firmware_version: null,
  serial_number: null,
  last_status: 'Available',
  last_boot_at: '2026-10-13T09:12:44Z',
  last_heartbeat_at: null,
  connectors: [
    {
      connector_id: 1,
      status: 'Charging',
      error_code: 'NoError',
      last_changed_at: '2026-10-13T08:47:04Z',
    },
  ],
});
describe('connector source freshness', () => {
  it('does not use an incorrect charger clock to outrank server-received status', () => {
    const event = {
      cpId: 'CP_TEST',
      topic: 'cp.status',
      cursor: 'k:1',
      timestamp: new Date('2026-10-13T14:10:00Z'),
      payload: {
        connectorId: 1,
        status: 'Available',
        errorCode: 'NoError',
        chargerReportedAt: '2099-01-01T00:00:00Z',
      },
    } as KafkaEvent;
    expect(mergeConnectorFromStatusEvent(row(), event).connectors[0]).toMatchObject({
      status: 'Available',
      last_changed_at: '2026-10-13T14:10:00.000Z',
    });
  });
  it('marks stale connector data on initial detail snapshot, including older gateways', async () => {
    const gw = { getChargePoint: async () => row() } as unknown as GatewayClient;
    const result = await resolveQuery('charge-point').snapshot({ cp_id: 'CP_TEST' }, gw);
    if (result.snapshot.kind !== 'charge-point') throw new Error('incorrect snapshot');
    expect(result.snapshot.row.connectors[0]).toMatchObject({
      status_freshness: 'stale',
      stale_reason: 'before_boot',
    });
  });
});
