// Operator-facing system status. Polled from SystemPage; cheap on the
// server side (one HTTP probe to the gateway + in-memory state).

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export interface ComponentStatus {
  ok: boolean;
  detail?: string;
  latency_ms?: number;
}

export interface SysStatus {
  console: { uptime_seconds: number; started_at: string };
  gateway: ComponentStatus & {
    version?: string;
    components?: Record<string, string | null>;
  };
  kafka: ComponentStatus & { topics?: string[]; consumer_running?: boolean };
  connections: { websockets: number };
}

export async function fetchSysStatus(token: string): Promise<SysStatus> {
  const res = await fetch(`${BASE}/sys/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`sys/status ${res.status}`);
  return (await res.json()) as SysStatus;
}
