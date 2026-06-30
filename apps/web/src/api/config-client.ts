// Read-only configuration introspection. Backed by GET /sys/config on the
// Console server, and GET /sys/gateway-config (proxied to the gateway's
// /api/v1/sys/config). Sensitive values arrive already masked.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export type RestartImpact = 'none' | 'console' | 'gateway' | 'both';
export type ValueSource = 'env' | 'default' | 'computed' | 'override';

export interface ConfigEntry {
  key: string;
  /** Stringified current value, or the mask when sensitive. */
  value: string;
  sensitive: boolean;
  default: string;
  source: ValueSource;
  description: string;
  mutable: boolean;
  restart: RestartImpact;
  range: string;
  /** Gateway-only fields. Empty string when reading the Console-side
   * endpoint, which doesn't carry these. */
  impact?: string;
  category?: string;
  stability?: string;
  /** Console-only: server signals whether this key is in the
   *  runtime-override allowlist. The UI gates the inline editor on
   *  this flag. Gateway entries don't set it; the allowlist there
   *  is keyed off the separate /sys/gateway-admin-config response. */
  overridable?: boolean;
}

export type ConfigScope = 'console' | 'gateway';

export interface SysConfig {
  entries: ConfigEntry[];
  scope: ConfigScope;
  loaded_at: string;
}

export async function fetchConsoleConfig(token: string): Promise<SysConfig> {
  const res = await fetch(`${BASE}/sys/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/config ${res.status}`);
  return (await res.json()) as SysConfig;
}

export async function fetchGatewayConfig(token: string): Promise<SysConfig> {
  const res = await fetch(`${BASE}/sys/gateway-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/gateway-config ${res.status}`);
  return (await res.json()) as SysConfig;
}

// ---- Gateway runtime overrides ------------------------------------------
// Mirrors the gateway's `/api/v1/admin/config` surface, proxied through
// the Console server so the browser never has to hold a gateway token.
//
// `allowlist` is the gateway's runtime-override allowlist (a map of
// field-name → human description). Anything in here is safe to mutate at
// runtime; everything else is read-only and requires a redeploy with a
// new env var.
//
// `overrides` records the values currently set in the gateway's per-pod
// override map. It is always a subset of `allowlist`. A key absent from
// `overrides` means "reading the env value"; a key present means
// "the value here is in effect, env value is the fallback after restart".

export interface GatewayAdminConfig {
  /** Full Settings dump. SecretStr fields auto-redact to '**********'. */
  settings?: Record<string, unknown>;
  overrides: Record<string, unknown>;
  allowlist: Record<string, string>;
  scope: string;
}

export async function fetchGatewayAdminConfig(token: string): Promise<GatewayAdminConfig> {
  const res = await fetch(`${BASE}/sys/gateway-admin-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/gateway-admin-config ${res.status}`);
  return (await res.json()) as GatewayAdminConfig;
}

// Sets one or more runtime overrides. Body shape mirrors the gateway:
// `{updates: {field: value, ...}}`. We POST instead of PATCH on the
// Console side to dodge a CORS preflight; the proxy translates to PATCH
// upstream.
export async function setGatewayAdminConfig(
  token: string,
  updates: Record<string, unknown>,
): Promise<GatewayAdminConfig> {
  const res = await fetch(`${BASE}/sys/gateway-admin-config`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ updates }),
  });
  if (!res.ok) {
    let message = `sys/gateway-admin-config ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string }; detail?: string };
      if (body?.error?.message) message = body.error.message;
      else if (body?.detail) message = body.detail;
    } catch {
      /* fall through to status-only message */
    }
    throw new Error(message);
  }
  return (await res.json()) as GatewayAdminConfig;
}

// Drops a specific override so the gateway falls back to its env value
// for that key on the next read.
export async function clearGatewayAdminOverride(
  token: string,
  key: string,
): Promise<GatewayAdminConfig> {
  const res = await fetch(`${BASE}/sys/gateway-admin-config/overrides/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let message = `sys/gateway-admin-config/overrides ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string }; detail?: string };
      if (body?.error?.message) message = body.error.message;
      else if (body?.detail) message = body.detail;
    } catch {
      /* fall through */
    }
    throw new Error(message);
  }
  return (await res.json()) as GatewayAdminConfig;
}

// -----------------------------------------------------------------------------
// Console-side runtime overrides
// -----------------------------------------------------------------------------
// Symmetric to the gateway-admin endpoints. The Console maintains its
// own override store at data/console-overrides.json; the route layer
// validates against the allowlist + the zod schema for each key.

export interface ConsoleAdminConfig {
  /** Entries shape mirrors SysConfigResponse.entries (one source of
   *  truth in the server's describeConfig). */
  entries: SysConfig['entries'];
  /** Allowlist of overridable keys. The UI only shows inline editors
   *  for keys in this set. */
  overridable_keys: string[];
}

export async function fetchConsoleAdminConfig(token: string): Promise<ConsoleAdminConfig> {
  const res = await fetch(`${BASE}/sys/admin/console-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/admin/console-config ${res.status}`);
  return (await res.json()) as ConsoleAdminConfig;
}

export async function setConsoleAdminConfig(
  token: string,
  key: string,
  value: unknown,
): Promise<ConsoleAdminConfig> {
  const res = await fetch(`${BASE}/sys/admin/console-config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, value: typeof value === 'string' ? value : String(value) }),
  });
  if (!res.ok) {
    let message = `sys/admin/console-config ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: unknown };
      if (typeof body?.error === 'string') message = body.error;
      if (body?.detail) message += `: ${JSON.stringify(body.detail)}`;
    } catch {
      /* fall through */
    }
    throw new Error(message);
  }
  return (await res.json()) as ConsoleAdminConfig;
}

export async function clearConsoleAdminOverride(
  token: string,
  key: string,
): Promise<ConsoleAdminConfig> {
  const res = await fetch(`${BASE}/sys/admin/console-config/overrides/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let message = `sys/admin/console-config/overrides ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body?.error === 'string') message = body.error;
    } catch {
      /* fall through */
    }
    throw new Error(message);
  }
  return (await res.json()) as ConsoleAdminConfig;
}
