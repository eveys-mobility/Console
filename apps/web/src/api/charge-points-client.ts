// Charge-point list via the Console server's `/sys/charge-points`
// proxy (fail-soft envelope). The live fleet views use the WS
// subscription instead; this REST path is for polled side panels
// such as the Authorizations page's "waiting for backend
// registration" list, where a 5 s poll matches the page's existing
// pending-queue refresh.

import type { ChargePointSummary } from '@eveys-console/protocol';

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export interface ChargePointListFilter {
  /** OCPP RegistrationStatus of the last BootNotification answer. */
  last_boot_status?: string;
  online?: boolean;
  limit?: number;
}

export interface ChargePointListResponse {
  charge_points: ChargePointSummary[];
  /** True when the Console server could not reach the gateway. */
  unavailable: boolean;
}

export async function listChargePoints(
  token: string,
  filter: ChargePointListFilter = {},
): Promise<ChargePointListResponse> {
  const qs = new URLSearchParams();
  if (filter.last_boot_status !== undefined) qs.set('last_boot_status', filter.last_boot_status);
  if (filter.online !== undefined) qs.set('online', String(filter.online));
  if (filter.limit !== undefined) qs.set('limit', String(filter.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${BASE}/sys/charge-points${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`charge-points.list ${res.status}`);
  const body = (await res.json()) as Partial<ChargePointListResponse>;
  return {
    charge_points: Array.isArray(body.charge_points) ? body.charge_points : [],
    unavailable: body.unavailable === true,
  };
}
