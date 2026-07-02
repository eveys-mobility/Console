// Device-authorization API client (#0013).
// Talks to the Console server's /sys/authorizations proxy, which forwards
// to the gateway's /api/v1/authorizations surface.
//
// The gateway only exposes the pending set (Redis-backed, 1 h TTL). Once
// a device is authorized / rejected / revoked, the row leaves this list —
// the gateway records the decision in its own log and the UI shows nothing
// but the pending queue.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export interface PendingAuthorization {
  cp_id: string;
  first_seen_at: string;
  last_seen_at: string;
  peer_ip: string | null;
  user_agent: string | null;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  serial_number: string | null;
  attempts: number;
}

interface ListResponse {
  items: PendingAuthorization[];
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function listAuthorizations(
  token: string,
  params: { limit?: number } = {},
): Promise<PendingAuthorization[]> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${BASE}/sys/authorizations${suffix}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`authorizations.list ${res.status}`);
  const body = (await res.json()) as ListResponse;
  return body.items;
}

async function decide(
  token: string,
  cpId: string,
  action: 'authorize' | 'reject' | 'revoke',
): Promise<unknown> {
  const res = await fetch(`${BASE}/sys/authorizations/${encodeURIComponent(cpId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`authorizations.${action} ${res.status}`);
  return res.json();
}

export function authorizeDevice(token: string, cpId: string) {
  return decide(token, cpId, 'authorize');
}

export function rejectAuthorization(token: string, cpId: string) {
  return decide(token, cpId, 'reject');
}

export function revokeAuthorization(token: string, cpId: string) {
  return decide(token, cpId, 'revoke');
}
