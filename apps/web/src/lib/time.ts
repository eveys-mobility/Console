// Time-formatting helpers shared across pages. Two flavours:
//
//   formatRelativeTime(iso)  →  '12s ago', '5m ago', '3h ago', '2d ago'
//                                 (or '—' for null, 'now' for sub-5s)
//
//   formatUptime(iso)        →  '45s', '12m', '2h 14m', '3d 4h'
//                                 (no suffix; meant to be paired with a
//                                  label like 'uptime: 2h 14m')
//
// Both anchor to `Date.now()` so any caller using them needs the page
// to re-render to advance — the consumer layouts here re-render on
// every snapshot/delta so this is fine. A 60s-tick global re-render
// is overkill for the read patterns we have.

/**
 * Render `iso` as a human-readable absolute timestamp in the user's
 * local timezone, formatted `YYYY-MM-DD HH:MM:SS ±HH:MM`. Used as the
 * hover/title companion to `formatRelativeTime`. Returns '—' on null /
 * unparseable.
 *
 * Local rather than UTC — operators want to read times in the zone
 * they're physically in. The trailing offset (e.g. `+03:00`) keeps it
 * unambiguous when correlating with logs that store UTC, so on-call
 * SREs can still convert without guessing the operator's locale.
 */
export function formatAbsoluteTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  // `getTimezoneOffset` returns minutes WEST of UTC; flip the sign so
  // a zone east of UTC (e.g. +03:00) prints with a '+'.
  const offsetMin = -d.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offset = `${offsetSign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`
  );
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const deltaSec = Math.round((Date.now() - t) / 1000);
  if (deltaSec < 5) return 'now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.round(deltaSec / 3600)}h ago`;
  return `${Math.round(deltaSec / 86_400)}d ago`;
}

/**
 * Render the duration since `iso` as a compact "Xd Yh" / "Xh Ym" / "Ym" /
 * "Xs" string. Returns '—' on null / unparseable / future timestamps.
 *
 * The two-component output (e.g. "3d 4h") is the common operator
 * expectation — single-component is not specific enough at large
 * scales, three-component is noise.
 */
export function formatUptime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const deltaSec = Math.floor((Date.now() - t) / 1000);
  if (deltaSec < 0) return '—'; // future timestamp; clock skew or bug
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) {
    const m = Math.floor(deltaSec / 60);
    return `${m}m`;
  }
  if (deltaSec < 86_400) {
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(deltaSec / 86_400);
  const h = Math.floor((deltaSec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Render a duration given as a millisecond delta, using the same
 * compact "Xs" / "Xm" / "Xh Ym" / "Xd Yh" style as `formatUptime`.
 * Unlike `formatUptime`, this takes an absolute duration rather than
 * "since-now" — fed by the statistics card (mean session duration)
 * and other call sites that already have the delta in hand. Returns
 * '—' for non-finite / negative input.
 */
export function formatDurationMinutes(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const deltaSec = Math.floor(ms / 1000);
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) {
    const m = Math.floor(deltaSec / 60);
    return `${m}m`;
  }
  if (deltaSec < 86_400) {
    const h = Math.floor(deltaSec / 3600);
    const m = Math.floor((deltaSec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(deltaSec / 86_400);
  const h = Math.floor((deltaSec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
