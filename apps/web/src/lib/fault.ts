// Fault-classification helpers shared by FleetPage / ChargerDetailPage /
// SystemPage. The wire shape gives us two signals per connector:
//
//   status        — Faulted is the OCPP "I cannot charge" terminal state
//   error_code    — categorises the problem (NoError when healthy)
//
// We collapse those into three operator-facing levels:
//
//   fault     status == 'Faulted'  →  blocks charging, red banner
//   advisory  error_code != NoError but status != Faulted
//                                  →  the charger is still useable but
//                                     reporting a problem; amber dot
//   ok        otherwise            →  no signal
//
// A charger as a whole takes the worst of its connectors.

import type { ChargePointSummary } from '@eveys-console/protocol';

import { NO_ERROR } from './ocpp-errors';

export type FaultLevel = 'fault' | 'advisory' | 'ok';

type Connector = ChargePointSummary['connectors'][number];

export function connectorFaultLevel(c: Connector): FaultLevel {
  // Retained reports remain visible in the data notice, not as current faults.
  if (c.status_freshness === 'stale' || c.status_freshness === 'unknown') return 'ok';
  if (c.status === 'Faulted') return 'fault';
  if (c.error_code && c.error_code !== NO_ERROR) return 'advisory';
  return 'ok';
}

/** Worst severity across the charger's connectors. */
export function chargePointFaultLevel(cp: ChargePointSummary): FaultLevel {
  let level: FaultLevel = 'ok';
  for (const c of cp.connectors) {
    const cl = connectorFaultLevel(c);
    if (cl === 'fault') return 'fault';
    if (cl === 'advisory') level = 'advisory';
  }
  return level;
}

/** Connectors with non-ok severity, in connector_id order. */
export function faultedConnectors(cp: ChargePointSummary): Connector[] {
  return cp.connectors
    .filter((c) => connectorFaultLevel(c) !== 'ok')
    .slice()
    .sort((a, b) => a.connector_id - b.connector_id);
}

export interface FaultCounts {
  fault: number;
  advisory: number;
  total: number;
}

/** Count chargers (not connectors) at each severity. */
export function countFaults(rows: ChargePointSummary[]): FaultCounts {
  let fault = 0;
  let advisory = 0;
  for (const cp of rows) {
    const level = chargePointFaultLevel(cp);
    if (level === 'fault') fault += 1;
    else if (level === 'advisory') advisory += 1;
  }
  return { fault, advisory, total: rows.length };
}
