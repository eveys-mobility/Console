// The gateway records how it answered a charger's most recent
// BootNotification (`last_boot_status`) and who decided
// (`last_boot_reason`, see the gateway's `boot_notification.py`).
// A charger whose last boot was not `Accepted` re-sends
// BootNotification forever and never sends StatusNotification, so it
// shows up here as "online, 0 connectors" — indistinguishable from a
// dead charger unless we say why. This module turns the pair into
// operator-facing words.
//
// Two different gates can hold a charger at boot, and the operator's
// habit is to reach for the Console's own Authorize button for both:
//
//   - the gateway's operator-authorization queue (Redis; shown on the
//     Authorizations page). The device has no `charge_points` row yet,
//     so it never carries a `last_boot_*` value;
//   - the TOGER backend's `/charge-points/register` answer. `Pending`
//     means no device in the panel has this `charge_point_id`. Only a
//     panel-side fix helps; Authorize here does nothing.
//
// `last_boot_reason` tells the two apart, and the copy below says so.

import type { ChargePointSummary } from '@eveys-console/protocol';

export type BootDecisionTone = 'warning' | 'destructive';

export interface BootDecision {
  /** OCPP RegistrationStatus the gateway answered: Pending / Rejected. */
  status: string;
  /** Raw machine reason from the gateway, if recorded. */
  reason: string | null;
  /** ISO time the gateway answered; null when not recorded. */
  decidedAt: string | null;
  /** Short badge text, e.g. `boot: Pending`. */
  label: string;
  /** One-line headline for the operator. */
  title: string;
  /** Full explanation + what to do. */
  detail: string;
  tone: BootDecisionTone;
}

/** True when the gateway recorded a last boot answer other than Accepted. */
export function bootBlocked(cp: ChargePointSummary): boolean {
  const status = cp.last_boot_status;
  return typeof status === 'string' && status.length > 0 && status !== 'Accepted';
}

function copyFor(
  reason: string | null,
  status: string,
  cpId: string,
): { title: string; detail: string; tone: BootDecisionTone } {
  switch (reason) {
    case 'backend_pending':
      return {
        title: 'Waiting for backend registration',
        detail:
          `The TOGER backend answered BootNotification with Pending: the device is not defined in ` +
          `the TOGER panel with charge_point_id ${cpId}. The charger retries boot every interval and ` +
          `never reports connectors until it is registered. Register the device in the panel; ` +
          `Authorizing it in this Console does not help — that is a different gate.`,
        tone: 'warning',
      };
    case 'backend_rejected':
      return {
        title: 'Backend rejected the boot',
        detail:
          'The TOGER backend answered BootNotification with Rejected. The charger will keep ' +
          'retrying; the device record in the panel needs attention before it can come up.',
        tone: 'destructive',
      };
    case 'backend_error':
      return {
        title: 'Backend error at boot',
        detail:
          'The TOGER backend returned an error for the registration call, so the gateway answered ' +
          'Rejected. Check the backend logs for this charge_point_id.',
        tone: 'destructive',
      };
    case 'backend_unavailable':
      return {
        title: 'Backend unreachable at boot',
        detail:
          `The gateway could not reach the TOGER backend when the charger booted and applied its ` +
          `fallback policy (answered ${status}). This is a backend availability problem, not a ` +
          `device registration problem; the next boot will be decided by the backend again.`,
        tone: status === 'Rejected' ? 'destructive' : 'warning',
      };
    case 'backend_unknown_status':
      return {
        title: 'Unrecognised backend answer',
        detail:
          'The TOGER backend returned a registration status the gateway does not know, so the ' +
          'gateway answered Pending (the safe default). Check the backend contract version.',
        tone: 'warning',
      };
    default:
      return {
        title: `Last boot answered ${status}`,
        detail: reason
          ? `The gateway answered the last BootNotification with ${status} (reason: ${reason}).`
          : `The gateway answered the last BootNotification with ${status}; no reason was recorded.`,
        tone: status === 'Rejected' ? 'destructive' : 'warning',
      };
  }
}

/** Operator-facing description of a blocked boot; null when not blocked. */
export function describeBootDecision(cp: ChargePointSummary): BootDecision | null {
  if (!bootBlocked(cp)) return null;
  const status = cp.last_boot_status as string;
  const reason = cp.last_boot_reason ?? null;
  const copy = copyFor(reason, status, cp.cp_id);
  return {
    status,
    reason,
    decidedAt: cp.last_boot_decided_at ?? null,
    label: `boot: ${status}`,
    ...copy,
  };
}
