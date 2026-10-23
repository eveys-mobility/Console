// `boot-decision.ts` turns the gateway's `last_boot_status` /
// `last_boot_reason` pair into what the operator reads: is this
// charger held back at BootNotification, by whom, and what to do.

import { describe, expect, it } from 'vitest';

import type { ChargePointSummary } from '@eveys-console/protocol';

import { bootBlocked, describeBootDecision } from '@/lib/boot-decision';

const cp = (over: Partial<ChargePointSummary> = {}): ChargePointSummary =>
  ({
    cp_id: 'SN20052210130151',
    online: true,
    pod_id: 'pod-1',
    vendor: 'EN+',
    model: 'DC120K-E2-B2',
    firmware_version: '1.1.670',
    serial_number: 'SN20052210130151',
    last_boot_at: '2026-10-22T17:01:00+00:00',
    last_heartbeat_at: null,
    last_status: null,
    connectors: [],
    ...over,
  }) as ChargePointSummary;

describe('bootBlocked', () => {
  it('is false when the gateway has not recorded a decision yet (null / absent)', () => {
    expect(bootBlocked(cp())).toBe(false);
    expect(bootBlocked(cp({ last_boot_status: null }))).toBe(false);
  });
  it('is false on Accepted', () => {
    expect(
      bootBlocked(cp({ last_boot_status: 'Accepted', last_boot_reason: 'backend_accepted' })),
    ).toBe(false);
  });
  it('is true on Pending and Rejected', () => {
    expect(
      bootBlocked(cp({ last_boot_status: 'Pending', last_boot_reason: 'backend_pending' })),
    ).toBe(true);
    expect(
      bootBlocked(cp({ last_boot_status: 'Rejected', last_boot_reason: 'backend_rejected' })),
    ).toBe(true);
  });
});

describe('describeBootDecision', () => {
  it('returns null when the boot is not blocked', () => {
    expect(describeBootDecision(cp())).toBeNull();
    expect(describeBootDecision(cp({ last_boot_status: 'Accepted' }))).toBeNull();
  });

  it('names the backend registration gap for backend_pending, with the cp_id', () => {
    const d = describeBootDecision(
      cp({
        last_boot_status: 'Pending',
        last_boot_reason: 'backend_pending',
        last_boot_decided_at: '2026-10-22T17:01:00+00:00',
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.label).toBe('boot: Pending');
    expect(d!.title).toBe('Waiting for backend registration');
    expect(d!.detail).toMatch(/not defined in the TOGER panel with charge_point_id/i);
    expect(d!.detail).toContain('SN20052210130151');
    // The operator's habit is to click Authorize — say plainly it won't help.
    expect(d!.detail).toMatch(/Authoriz(e|ing) .*does not help/i);
    expect(d!.tone).toBe('warning');
  });

  it('marks backend_rejected / backend_error as destructive', () => {
    const rejected = describeBootDecision(
      cp({ last_boot_status: 'Rejected', last_boot_reason: 'backend_rejected' }),
    );
    expect(rejected!.label).toBe('boot: Rejected');
    expect(rejected!.title).toMatch(/backend rejected/i);
    expect(rejected!.tone).toBe('destructive');

    const error = describeBootDecision(
      cp({ last_boot_status: 'Rejected', last_boot_reason: 'backend_error' }),
    );
    expect(error!.title).toMatch(/backend error/i);
    expect(error!.tone).toBe('destructive');
  });

  it('explains backend_unavailable as a gateway fallback, not a registration problem', () => {
    const d = describeBootDecision(
      cp({ last_boot_status: 'Rejected', last_boot_reason: 'backend_unavailable' }),
    );
    expect(d!.title).toMatch(/backend unreachable/i);
    expect(d!.detail).toMatch(/fallback/i);
    expect(d!.detail).not.toMatch(/charge_point_id/);
  });

  it('explains backend_unknown_status', () => {
    const d = describeBootDecision(
      cp({ last_boot_status: 'Pending', last_boot_reason: 'backend_unknown_status' }),
    );
    expect(d!.title).toMatch(/unrecognised backend answer/i);
  });

  it('falls back to a generic line that still shows the raw reason', () => {
    const d = describeBootDecision(
      cp({ last_boot_status: 'Pending', last_boot_reason: 'something_new' }),
    );
    expect(d!.label).toBe('boot: Pending');
    expect(d!.detail).toContain('something_new');
    const noReason = describeBootDecision(
      cp({ last_boot_status: 'Pending', last_boot_reason: null }),
    );
    expect(noReason!.detail).toMatch(/Pending/);
  });
});
