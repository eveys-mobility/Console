import { describe, expect, it } from 'vitest';
import { chargePointSummary, mergeChargePoint } from '../src/index.js';

const row = (at: string | null, boot = '2026-10-13T09:12:44Z') =>
  chargePointSummary.parse({
    cp_id: 'CP_TEST',
    online: true,
    pod_id: 'test',
    vendor: null,
    model: null,
    firmware_version: null,
    serial_number: null,
    last_status: 'Available',
    last_boot_at: boot,
    last_heartbeat_at: '2026-10-13T14:00:00Z',
    connectors: [
      { connector_id: 1, status: 'Charging', error_code: 'NoError', last_changed_at: at },
    ],
  });

describe('connector status across reboot', () => {
  it('marks a successful archive row from before the latest boot as stale', () => {
    const result = mergeChargePoint(undefined, row('2026-10-13T08:47:04Z'));
    expect(result.connectors[0]).toMatchObject({
      status: 'Charging',
      status_freshness: 'stale',
      stale_reason: 'before_boot',
    });
  });
  it('invalidates retained last-known data when boot changes during a subscription', () => {
    const old = row('2026-10-13T08:47:04Z', '2026-10-13T08:46:53Z');
    const update = {
      ...row('2026-10-13T08:47:04Z'),
      connectors: [],
      connectors_state: 'unavailable' as const,
    };
    expect(mergeChargePoint(old, update).connectors[0]).toMatchObject({
      status_freshness: 'stale',
      stale_reason: 'before_boot',
    });
  });
  it('compares UTC instants and accepts a notification at the current boot', () => {
    expect(
      mergeChargePoint(undefined, row('2026-10-13T12:12:44+03:00')).connectors[0],
    ).toMatchObject({ status_freshness: 'current' });
  });
  it('does not assert current status without an observation timestamp after a known boot', () => {
    expect(mergeChargePoint(undefined, row(null)).connectors[0]).toMatchObject({
      status_freshness: 'unknown',
      stale_reason: 'unverified_timestamp',
    });
  });
  it('never marks nullable boot and observation timestamps current', () => {
    const input = { ...row(null), last_boot_at: null };
    expect(mergeChargePoint(undefined, input).connectors[0]).toMatchObject({
      status_freshness: 'unknown',
      stale_reason: 'unverified_timestamp',
    });
  });
  it('does not attest the active boot epoch when the boot time is absent', () => {
    const input = { ...row('2026-10-13T14:00:00Z'), last_boot_at: null };
    expect(mergeChargePoint(undefined, input).connectors[0]).toMatchObject({
      status_freshness: 'unknown',
    });
  });
});
