import { describe, expect, it } from 'vitest';

import type { ChargePointSummary } from '@eveys-console/protocol';

import {
  canRemoteStart,
  canRemoteStop,
  canReset,
  hasActiveSession,
  hasStartableConnector,
} from '@/lib/charger-state';

type Connector = ChargePointSummary['connectors'][number];

const conn = (over: Partial<Connector> = {}): Connector => ({
  connector_id: 1,
  status: 'Available',
  error_code: 'NoError',
  last_changed_at: '2026-10-13T09:13:00Z',
  ...over,
});

const cp = (
  over: Partial<ChargePointSummary> & { connectors?: Connector[] } = {},
): ChargePointSummary =>
  ({
    cp_id: 'CP_X',
    online: true,
    pod_id: 'pod-1',
    vendor: 'Eveys',
    model: 'X1',
    firmware_version: '1.0.0',
    serial_number: 'SN1',
    last_boot_at: '2026-10-13T09:12:44Z',
    last_heartbeat_at: null,
    last_status: 'Available',
    connectors: [conn()],
    ...over,
  }) as ChargePointSummary;

describe('hasActiveSession', () => {
  it('flags Charging / SuspendedEV / SuspendedEVSE / Preparing / Finishing', () => {
    for (const s of ['Charging', 'SuspendedEV', 'SuspendedEVSE', 'Preparing', 'Finishing']) {
      expect(hasActiveSession(cp({ connectors: [conn({ status: s })] }))).toBe(true);
    }
  });
  it('does not flag Available / Reserved / Unavailable / Faulted', () => {
    for (const s of ['Available', 'Reserved', 'Unavailable', 'Faulted']) {
      expect(hasActiveSession(cp({ connectors: [conn({ status: s })] }))).toBe(false);
    }
  });
  it('returns true if ANY connector is in a session', () => {
    expect(
      hasActiveSession(
        cp({
          connectors: [
            conn({ connector_id: 1, status: 'Available' }),
            conn({ connector_id: 2, status: 'Charging' }),
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('hasStartableConnector', () => {
  it('returns true on Available', () => {
    expect(hasStartableConnector(cp({ connectors: [conn({ status: 'Available' })] }))).toBe(true);
  });
  it('returns true on Preparing (cable plugged, waiting for Authorize)', () => {
    expect(hasStartableConnector(cp({ connectors: [conn({ status: 'Preparing' })] }))).toBe(true);
  });
  it('returns false on Charging / Finishing / Faulted', () => {
    for (const s of ['Charging', 'Finishing', 'Faulted']) {
      expect(hasStartableConnector(cp({ connectors: [conn({ status: s })] }))).toBe(false);
    }
  });
});

describe('canRemoteStart', () => {
  it('disabled when offline', () => {
    expect(canRemoteStart(cp({ online: false }))).toEqual({
      enabled: false,
      reason: expect.stringMatching(/offline/),
    });
  });
  it('disabled with no connectors reported yet', () => {
    expect(canRemoteStart(cp({ connectors: [] }))).toEqual({
      enabled: false,
      reason: expect.stringMatching(/no connectors/i),
    });
  });
  it('disabled when every connector is busy', () => {
    expect(
      canRemoteStart(
        cp({
          connectors: [
            conn({ connector_id: 1, status: 'Charging' }),
            conn({ connector_id: 2, status: 'Charging' }),
          ],
        }),
      ),
    ).toEqual({ enabled: false, reason: expect.stringMatching(/Available/) });
  });
  it('enabled when at least one connector is Available', () => {
    expect(
      canRemoteStart(
        cp({
          connectors: [
            conn({ connector_id: 1, status: 'Charging' }),
            conn({ connector_id: 2, status: 'Available' }),
          ],
        }),
      ),
    ).toEqual({ enabled: true });
  });
});

describe('canRemoteStop', () => {
  it('disabled when offline', () => {
    expect(canRemoteStop(cp({ online: false }))).toEqual({
      enabled: false,
      reason: expect.stringMatching(/offline/),
    });
  });
  it('disabled when nothing is charging', () => {
    expect(canRemoteStop(cp({ connectors: [conn({ status: 'Available' })] }))).toEqual({
      enabled: false,
      reason: expect.stringMatching(/No active session/),
    });
  });
  it('enabled when any connector is in a session', () => {
    expect(canRemoteStop(cp({ connectors: [conn({ status: 'Charging' })] }))).toEqual({
      enabled: true,
    });
  });
});

describe('canReset', () => {
  it('disabled when offline', () => {
    expect(canReset(cp({ online: false }))).toEqual({
      enabled: false,
      reason: expect.stringMatching(/offline/),
    });
  });
  it('enabled otherwise', () => {
    expect(canReset(cp())).toEqual({ enabled: true });
  });
});
