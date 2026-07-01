// Per-charger statistics computation. Pure function, no React, no
// network — fed a list of TransactionRow that the StatisticsCard
// pages out of /sys/charge-points/:cp_id/transactions and reduces
// in the browser.
//
// Why client-side for v1: the gateway has no `/stats` aggregation
// endpoint yet, but the per-cp transaction list does what we need
// at typical operator scale (a few hundred sessions over a quarter,
// thousands over a year — well inside the 2,500-row paging cap the
// card uses). When the gateway grows a real aggregation endpoint
// we'll switch the card's data source; the tile layout stays put.
//
// Window semantics: filter by `started_at`. A session that started
// before the window but stopped inside it is treated as outside —
// `started_at` is the simplest, most defensible cutoff and matches
// how the Transactions list paginates.

import type { TransactionRow } from '@/api/transactions-client';

export type StatsWindow = 'all' | '24h' | '7d' | '30d';

export interface ChargerStats {
  window: StatsWindow;
  /** Total sessions whose `started_at` is in the window. Includes open ones. */
  totalSessions: number;
  /** Subset of `totalSessions` that are closed (stopped). */
  completedSessions: number;
  /** Open sessions in the window — typically 0 or 1, but a multi-connector
   *  charger could legitimately have several concurrent. */
  activeNow: number;
  /** Sum of (meter_stop − meter_start) / 1000 over closed sessions in the
   *  window. Negative deltas (corrupt rows) contribute 0. */
  totalEnergyKwh: number;
  /** Mean (stopped_at − started_at) over closed sessions in the window,
   *  in minutes. `null` if there are no closed sessions in the window. */
  meanSessionMinutes: number | null;
  /** ISO-8601 of the latest `started_at` in the window. Note this is
   *  driven by `started_at`, not `stopped_at` — a long-running session
   *  that started yesterday wins over a short one that started today only
   *  if its `started_at` is more recent (which it isn't). */
  lastSessionStartedAt: string | null;
}

const WINDOW_MS: Record<Exclude<StatsWindow, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface ComputeStatsOptions {
  /** Anchor for window arithmetic. Defaults to `new Date()`; tests
   *  inject a fixed clock. */
  now?: Date;
  /** Resolver that, given an open session, returns the latest live
   *  meter-register value in Wh (i.e. what the charger's energy
   *  register currently reads). When present, `totalEnergyKwh`
   *  includes `Math.max(0, currentWh - meter_start_wh)` for each open
   *  session in the window, so the tile reflects delivered-so-far
   *  energy instead of freezing at the last completed session's total.
   *  Return null to skip contribution — e.g. no live sample yet for
   *  a just-started session. */
  currentEnergyWh?: (t: TransactionRow) => number | null;
}

export function computeStats(
  transactions: TransactionRow[],
  window: StatsWindow,
  opts: ComputeStatsOptions | Date = {},
): ChargerStats {
  // Preserve the earlier `now: Date` positional signature so existing
  // tests that pass a raw Date still work.
  const options: ComputeStatsOptions = opts instanceof Date ? { now: opts } : opts;
  const now = options.now ?? new Date();
  const cutoff = window === 'all' ? null : now.getTime() - WINDOW_MS[window];

  // Filter by `started_at` — the documented semantics. A session that
  // started before the cutoff but stopped after it is still "outside";
  // counting it would double-count when the user switches to a wider window.
  const inWindow = transactions.filter((t) => {
    if (cutoff === null) return true;
    const startedMs = Date.parse(t.started_at);
    return Number.isFinite(startedMs) && startedMs >= cutoff;
  });

  let totalEnergyWh = 0;
  let durationSumMs = 0;
  let completed = 0;
  let active = 0;
  let lastStartedAtMs = -Infinity;
  let lastStartedAtIso: string | null = null;

  for (const t of inWindow) {
    const startedMs = Date.parse(t.started_at);
    if (Number.isFinite(startedMs) && startedMs > lastStartedAtMs) {
      lastStartedAtMs = startedMs;
      lastStartedAtIso = t.started_at;
    }

    if (t.open) {
      active += 1;
      // Open sessions: fold in delivered-so-far energy from the live
      // meter-register when the caller supplied a resolver. Without
      // one, or before the first live sample, they contribute zero —
      // same as before. Mean duration deliberately stays over closed
      // sessions only (stop is still unknown).
      const currentWh = options.currentEnergyWh?.(t);
      if (currentWh != null) {
        const deltaWh = currentWh - t.meter_start_wh;
        if (deltaWh > 0) totalEnergyWh += deltaWh;
      }
      continue;
    }

    completed += 1;

    if (t.meter_stop_wh !== null) {
      const deltaWh = t.meter_stop_wh - t.meter_start_wh;
      // Negative deltas would indicate a corrupt row (charger reset its
      // meter mid-session, reporting glitch); ignore rather than subtract.
      if (deltaWh > 0) totalEnergyWh += deltaWh;
    }

    if (t.stopped_at) {
      const stoppedMs = Date.parse(t.stopped_at);
      if (Number.isFinite(startedMs) && Number.isFinite(stoppedMs) && stoppedMs >= startedMs) {
        durationSumMs += stoppedMs - startedMs;
      }
    }
  }

  const meanSessionMinutes = completed === 0 ? null : durationSumMs / completed / 60_000;

  return {
    window,
    totalSessions: inWindow.length,
    completedSessions: completed,
    activeNow: active,
    totalEnergyKwh: totalEnergyWh / 1000,
    meanSessionMinutes,
    lastSessionStartedAt: lastStartedAtIso,
  };
}
