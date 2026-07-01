// Webhook backlog admin client (E3-9 tail).
// Talks to the Console server's /sys/webhook-backlog proxy, which forwards
// to the gateway's /api/v1/webhook-backlog surface documented in
// eveys-ocpp/docs/integration/03-webhooks.md.
//
// Types mirror the gateway's snake_case wire shape 1:1 so the proxy stays
// dumb — no field renaming, no unit conversion.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export interface WebhookBacklogRow {
  id: string;
  event_id: string;
  event_type: string;
  url: string;
  signature: string;
  created_at: string | null;
  next_attempt_at: string | null;
  attempts: number;
  last_error: string | null;
  dead: boolean;
}

/** Single-row response — same shape as `WebhookBacklogRow` plus the raw
 *  body base64-encoded so operators can inspect what would be sent. */
export interface WebhookBacklogRowDetail extends WebhookBacklogRow {
  /** Base64-encoded pending JSON body. Decode with `atob`. */
  body_b64: string;
}

export interface WebhookBacklogListResponse {
  rows: WebhookBacklogRow[];
  next_cursor: string | null;
}

export interface WebhookBacklogListParams {
  dead?: boolean;
  event_type?: readonly string[];
  cursor?: string;
  limit?: number;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function listWebhookBacklog(
  token: string,
  params: WebhookBacklogListParams = {},
): Promise<WebhookBacklogListResponse> {
  const qs = new URLSearchParams();
  if (params.dead !== undefined) qs.set('dead', String(params.dead));
  for (const t of params.event_type ?? []) qs.append('event_type', t);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetch(`${BASE}/sys/webhook-backlog${suffix}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`webhook-backlog.list ${res.status}`);
  return (await res.json()) as WebhookBacklogListResponse;
}

export async function getWebhookBacklog(
  token: string,
  id: string,
): Promise<WebhookBacklogRowDetail> {
  const res = await fetch(`${BASE}/sys/webhook-backlog/${encodeURIComponent(id)}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`webhook-backlog.get ${res.status}`);
  return (await res.json()) as WebhookBacklogRowDetail;
}

export async function replayWebhookBacklog(token: string, id: string): Promise<WebhookBacklogRow> {
  const res = await fetch(`${BASE}/sys/webhook-backlog/${encodeURIComponent(id)}/replay`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`webhook-backlog.replay ${res.status}`);
  return (await res.json()) as WebhookBacklogRow;
}

export async function purgeWebhookBacklog(
  token: string,
  id: string,
): Promise<{ deleted: boolean; id: string }> {
  const res = await fetch(`${BASE}/sys/webhook-backlog/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!res.ok) throw new Error(`webhook-backlog.purge ${res.status}`);
  return (await res.json()) as { deleted: boolean; id: string };
}

export async function replayDeadWebhookBacklog(
  token: string,
  eventTypes?: readonly string[],
): Promise<{ count: number }> {
  const body = eventTypes && eventTypes.length > 0 ? { event_type: eventTypes } : {};
  const res = await fetch(`${BASE}/sys/webhook-backlog/replay-dead`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`webhook-backlog.replay-dead ${res.status}`);
  return (await res.json()) as { count: number };
}
