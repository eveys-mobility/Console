// Helpers that map a charger's reported connector status to "what
// command can the operator usefully send right now?".
//
// OCPP 1.6 connector states (StatusNotification):
//
//   Available  Preparing  Charging  SuspendedEV  SuspendedEVSE
//   Finishing  Reserved   Unavailable  Faulted
//
// "Active session" = any of the in-session states the OCPP transition
// graph traverses between StartTransaction and StopTransaction:
// Preparing, Charging, SuspendedEV, SuspendedEVSE, Finishing.
//
// We deliberately treat the *fleet* of connectors as the charger's
// state — a multi-connector charger can have one connector Charging
// and another Available, in which case RemoteStart is still useful
// (different connector) and RemoteStop is meaningful too.

import { withConnectorFreshness } from '@eveys-console/protocol';
import type { ChargePointSummary } from '@eveys-console/protocol';

export const ACTIVE_SESSION_STATUSES = new Set([
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
]);

export const STARTABLE_STATUSES = new Set(['Available', 'Preparing']);

type Connector = ChargePointSummary['connectors'][number];

function isActiveSession(c: Connector): boolean {
  return (
    c.connector_id > 0 && c.status_freshness === 'current' && ACTIVE_SESSION_STATUSES.has(c.status)
  );
}

function isStartable(c: Connector): boolean {
  return c.connector_id > 0 && c.status_freshness === 'current' && STARTABLE_STATUSES.has(c.status);
}

/** Any connector currently inside a session. */
export function hasActiveSession(cp: ChargePointSummary): boolean {
  return withConnectorFreshness(cp).connectors.some(isActiveSession);
}

/** Any connector currently free to start a session on. */
export function hasStartableConnector(cp: ChargePointSummary): boolean {
  return withConnectorFreshness(cp).connectors.some(isStartable);
}

export interface CommandAvailability {
  /** Whether the button should be enabled. */
  enabled: boolean;
  /** Reason to surface on hover when disabled. */
  reason?: string;
}

export function canRemoteStart(cp: ChargePointSummary): CommandAvailability {
  if (!cp.online) return { enabled: false, reason: 'Charger is offline.' };
  if (cp.connectors.length === 0) return { enabled: false, reason: 'No connectors reported yet.' };
  if (!hasStartableConnector(cp))
    return { enabled: false, reason: 'No connector is Available — already in a session?' };
  return { enabled: true };
}

export function canRemoteStop(cp: ChargePointSummary): CommandAvailability {
  if (!cp.online) return { enabled: false, reason: 'Charger is offline.' };
  if (!hasActiveSession(cp)) return { enabled: false, reason: 'No active session to stop.' };
  return { enabled: true };
}

export function canReset(cp: ChargePointSummary): CommandAvailability {
  if (!cp.online) return { enabled: false, reason: 'Charger is offline.' };
  return { enabled: true };
}
