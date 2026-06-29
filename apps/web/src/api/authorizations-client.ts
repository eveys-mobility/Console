// Device-authorization API client (#0013).
// Talks to the Console server's /sys/authorizations proxy, which forwards
// to the gateway's /api/v1/authorizations surface.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export type AuthorizationStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface Authorization {
  cp_id: string;
  status: AuthorizationStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  last_attempt_ip: string | null;
  last_attempt_user_agent: string | null;
  last_attempt_at: string | null;
}

interface ListResponse {
  items: Authorization[];
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function listAuthorizations(
  token: string,
  params: { status?: AuthorizationStatus; limit?: number } = {},
): Promise<Authorization[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
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
  action: 'approve' | 'reject' | 'revoke',
): Promise<Authorization> {
  const res = await fetch(`${BASE}/sys/authorizations/${encodeURIComponent(cpId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`authorizations.${action} ${res.status}`);
  return (await res.json()) as Authorization;
}

export function approveAuthorization(token: string, cpId: string) {
  return decide(token, cpId, 'approve');
}

export function rejectAuthorization(token: string, cpId: string) {
  return decide(token, cpId, 'reject');
}

export function revokeAuthorization(token: string, cpId: string) {
  return decide(token, cpId, 'revoke');
}
