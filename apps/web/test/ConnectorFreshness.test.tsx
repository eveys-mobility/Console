import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { withConnectorFreshness } from '@eveys-console/protocol';
import type { ChargePointSummary } from '@eveys-console/protocol';
import { chargePointFaultLevel, faultedConnectors } from '@/lib/fault';
import { computeAlerts } from '@/lib/alerts';
import { ConnectorDataNotice, physicalConnectors } from '@/components/ConnectorDataNotice';
import { canRemoteStart, canRemoteStop } from '@/lib/charger-state';

afterEach(cleanup);
const cp = (status = 'Charging'): ChargePointSummary => ({
  cp_id: 'CP_TEST',
  online: true,
  pod_id: 'test',
  vendor: null,
  model: null,
  firmware_version: null,
  serial_number: null,
  last_status: 'Available',
  last_boot_at: '2026-10-13T09:12:44Z',
  last_heartbeat_at: '2026-10-13T14:00:00Z',
  connectors_state: 'available',
  connectors: [
    {
      connector_id: 0,
      status: 'Available',
      error_code: 'NoError',
      last_changed_at: '2026-10-13T09:13:00Z',
    },
    { connector_id: 1, status, error_code: 'NoError', last_changed_at: '2026-10-13T08:47:04Z' },
  ],
});

describe('stale connector presentation and controls', () => {
  it('presents pre-boot Charging as Unknown while retaining its reported value', () => {
    expect(physicalConnectors(cp())[0]).toMatchObject({
      status: 'Unknown',
      reported_status: 'Charging',
    });
  });
  it('explains stale data even when the archive query succeeded', () => {
    render(<ConnectorDataNotice cp={cp()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/current connector status is unknown/i);
    expect(screen.getByRole('status')).toHaveTextContent(/1: Charging/);
  });
  it('does not enable Stop based on pre-boot Charging', () => {
    expect(canRemoteStop(cp()).enabled).toBe(false);
  });
  it('does not enable Start using connector zero or stale Available', () => {
    expect(canRemoteStart(cp('Available')).enabled).toBe(false);
  });
  it('does not present a stale Faulted report as a current fault', () => {
    expect(chargePointFaultLevel(withConnectorFreshness(cp('Faulted')))).toBe('ok');
  });
  it('keeps stale fault evidence out of the current fault banner', () => {
    expect(faultedConnectors(withConnectorFreshness(cp('Faulted')))).toEqual([]);
  });
  it('does not derive a current charger fault alert from stale evidence', () => {
    expect(
      computeAlerts({ charge_points: [withConnectorFreshness(cp('Faulted'))], sys_status: null }),
    ).toEqual([]);
  });
  it('does not derive a current advisory alert from unknown evidence', () => {
    const row = withConnectorFreshness(cp());
    row.connectors[1]!.error_code = 'OverCurrentFailure';
    expect(computeAlerts({ charge_points: [row], sys_status: null })).toEqual([]);
  });
});
