import { describe, expect, it } from 'vitest';

import type { TransactionRow } from '@/api/transactions-client';
import { computeStats } from '@/lib/stats';

const NOW = new Date('2026-05-10T12:00:00Z');

function row(over: Partial<TransactionRow> = {}): TransactionRow {
  const open = over.open ?? false;
  return {
    transaction_id: over.transaction_id ?? 1,
    cp_id: over.cp_id ?? 'cp_test',
    connector_id: over.connector_id ?? 1,
    id_tag: over.id_tag ?? 'TAG',
    meter_start_wh: over.meter_start_wh ?? 0,
    started_at: over.started_at ?? '2026-05-10T10:00:00Z',
    meter_stop_wh: over.meter_stop_wh ?? (open ? null : 1000),
    stopped_at: over.stopped_at ?? (open ? null : '2026-05-10T11:00:00Z'),
    stop_reason: over.stop_reason ?? (open ? null : 'Local'),
    open,
  };
}

describe('computeStats', () => {
  it('returns zeros / nulls for an empty transaction list', () => {
    const stats = computeStats([], 'all', NOW);
    expect(stats).toEqual({
      window: 'all',
      totalSessions: 0,
      completedSessions: 0,
      activeNow: 0,
      totalEnergyKwh: 0,
      meanSessionMinutes: null,
      lastSessionStartedAt: null,
    });
  });

  it('all-time: sums energy, computes mean duration, finds latest start', () => {
    const stats = computeStats(
      [
        // 1 hour, 5 kWh
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 5000,
          started_at: '2026-05-10T08:00:00Z',
          stopped_at: '2026-05-10T09:00:00Z',
        }),
        // 30 min, 2 kWh
        row({
          transaction_id: 2,
          meter_start_wh: 1000,
          meter_stop_wh: 3000,
          started_at: '2026-05-10T11:00:00Z',
          stopped_at: '2026-05-10T11:30:00Z',
        }),
      ],
      'all',
      NOW,
    );
    expect(stats.totalSessions).toBe(2);
    expect(stats.completedSessions).toBe(2);
    expect(stats.activeNow).toBe(0);
    expect(stats.totalEnergyKwh).toBe(7);
    // (60 + 30) / 2 = 45
    expect(stats.meanSessionMinutes).toBe(45);
    expect(stats.lastSessionStartedAt).toBe('2026-05-10T11:00:00Z');
  });

  it('open sessions count toward totalSessions but not energy/mean-duration', () => {
    const stats = computeStats(
      [
        row({
          transaction_id: 1,
          open: true,
          started_at: '2026-05-10T11:00:00Z',
        }),
        // 1 hour, 4 kWh closed
        row({
          transaction_id: 2,
          meter_start_wh: 0,
          meter_stop_wh: 4000,
          started_at: '2026-05-10T08:00:00Z',
          stopped_at: '2026-05-10T09:00:00Z',
        }),
      ],
      'all',
      NOW,
    );
    expect(stats.totalSessions).toBe(2);
    expect(stats.completedSessions).toBe(1);
    expect(stats.activeNow).toBe(1);
    expect(stats.totalEnergyKwh).toBe(4);
    expect(stats.meanSessionMinutes).toBe(60);
  });

  it('24h window filters out an older closed session, keeps a recent open one', () => {
    const stats = computeStats(
      [
        // Closed 5 days ago — outside 24h.
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 9000,
          started_at: '2026-05-05T10:00:00Z',
          stopped_at: '2026-05-05T11:00:00Z',
        }),
        // Open within the last 24h.
        row({
          transaction_id: 2,
          open: true,
          started_at: '2026-05-10T08:00:00Z',
        }),
      ],
      '24h',
      NOW,
    );
    expect(stats.totalSessions).toBe(1);
    expect(stats.completedSessions).toBe(0);
    expect(stats.activeNow).toBe(1);
    expect(stats.totalEnergyKwh).toBe(0);
    expect(stats.meanSessionMinutes).toBeNull();
  });

  it('treats negative meter delta as 0 energy contribution', () => {
    const stats = computeStats(
      [
        row({
          transaction_id: 1,
          meter_start_wh: 5000,
          meter_stop_wh: 4000,
          started_at: '2026-05-10T10:00:00Z',
          stopped_at: '2026-05-10T11:00:00Z',
        }),
      ],
      'all',
      NOW,
    );
    expect(stats.completedSessions).toBe(1);
    expect(stats.totalEnergyKwh).toBe(0);
  });

  it('lastSessionStartedAt is the most recent started_at, not the latest stop', () => {
    const stats = computeStats(
      [
        // Started later but very short.
        row({
          transaction_id: 2,
          meter_start_wh: 0,
          meter_stop_wh: 200,
          started_at: '2026-05-10T11:30:00Z',
          stopped_at: '2026-05-10T11:35:00Z',
        }),
        // Started earlier, ended later (long session).
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 5000,
          started_at: '2026-05-10T09:00:00Z',
          stopped_at: '2026-05-10T11:50:00Z',
        }),
      ],
      'all',
      NOW,
    );
    expect(stats.lastSessionStartedAt).toBe('2026-05-10T11:30:00Z');
  });

  it('activeNow counts every open session in the window', () => {
    const stats = computeStats(
      [
        row({ transaction_id: 1, open: true, started_at: '2026-05-10T11:00:00Z' }),
        row({ transaction_id: 2, open: true, started_at: '2026-05-10T11:30:00Z' }),
        row({
          transaction_id: 3,
          open: false,
          meter_start_wh: 0,
          meter_stop_wh: 1000,
          started_at: '2026-05-10T10:00:00Z',
          stopped_at: '2026-05-10T10:30:00Z',
        }),
      ],
      'all',
      NOW,
    );
    expect(stats.activeNow).toBe(2);
    expect(stats.totalSessions).toBe(3);
    expect(stats.completedSessions).toBe(1);
  });

  it('30d window includes a session inside the boundary and excludes one outside', () => {
    const stats = computeStats(
      [
        // 31 days old — outside.
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 8000,
          started_at: '2026-04-09T11:00:00Z',
          stopped_at: '2026-04-09T12:00:00Z',
        }),
        // 10 days old — inside.
        row({
          transaction_id: 2,
          meter_start_wh: 0,
          meter_stop_wh: 3000,
          started_at: '2026-04-30T10:00:00Z',
          stopped_at: '2026-04-30T11:00:00Z',
        }),
      ],
      '30d',
      NOW,
    );
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalEnergyKwh).toBe(3);
  });

  it('a session that started before the window is excluded even if it stopped inside', () => {
    // started_at is the documented cutoff — this test pins that contract.
    const stats = computeStats(
      [
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 1000,
          // Started 8 days before NOW, stopped 3 hours before NOW.
          started_at: '2026-05-02T12:00:00Z',
          stopped_at: '2026-05-10T09:00:00Z',
        }),
      ],
      '7d',
      NOW,
    );
    expect(stats.totalSessions).toBe(0);
    expect(stats.completedSessions).toBe(0);
    expect(stats.totalEnergyKwh).toBe(0);
  });

  it('mixes open + closed in 7d window correctly', () => {
    const stats = computeStats(
      [
        row({
          transaction_id: 1,
          meter_start_wh: 0,
          meter_stop_wh: 2000,
          started_at: '2026-05-08T10:00:00Z',
          stopped_at: '2026-05-08T11:00:00Z',
        }),
        row({
          transaction_id: 2,
          meter_start_wh: 0,
          meter_stop_wh: 4000,
          started_at: '2026-05-09T10:00:00Z',
          stopped_at: '2026-05-09T12:00:00Z',
        }),
        row({
          transaction_id: 3,
          open: true,
          started_at: '2026-05-10T11:00:00Z',
        }),
      ],
      '7d',
      NOW,
    );
    expect(stats.totalSessions).toBe(3);
    expect(stats.completedSessions).toBe(2);
    expect(stats.activeNow).toBe(1);
    expect(stats.totalEnergyKwh).toBe(6);
    // (60 + 120) / 2 = 90
    expect(stats.meanSessionMinutes).toBe(90);
    expect(stats.lastSessionStartedAt).toBe('2026-05-10T11:00:00Z');
  });

  it('folds live meter-register into totalEnergyKwh for open sessions', () => {
    const rows = [
      // Closed: 5 kWh
      row({
        transaction_id: 1,
        meter_start_wh: 0,
        meter_stop_wh: 5000,
        started_at: '2026-05-10T09:00:00Z',
        stopped_at: '2026-05-10T10:00:00Z',
      }),
      // Open: charger's register currently reads 8000 Wh, started at 0 → 8 kWh live.
      row({
        transaction_id: 2,
        connector_id: 1,
        open: true,
        meter_start_wh: 0,
        started_at: '2026-05-10T11:30:00Z',
      }),
      // Open: no live sample yet → contributes zero.
      row({
        transaction_id: 3,
        connector_id: 2,
        open: true,
        meter_start_wh: 100,
        started_at: '2026-05-10T11:45:00Z',
      }),
    ];
    const stats = computeStats(rows, 'all', {
      now: NOW,
      currentEnergyWh: (t) => (t.transaction_id === 2 ? 8000 : null),
    });
    // 5 (closed) + 8 (live open tx=2) + 0 (no live sample for tx=3) = 13 kWh
    expect(stats.totalEnergyKwh).toBe(13);
    expect(stats.activeNow).toBe(2);
    expect(stats.completedSessions).toBe(1);
  });

  it('ignores a negative live delta (register < meter_start_wh)', () => {
    // Charger reported a meter reset mid-session: register briefly reads
    // below the start value. Clamp to 0 rather than subtract, same
    // treatment as the corrupt-closed-row case.
    const rows = [
      row({
        transaction_id: 9,
        open: true,
        meter_start_wh: 10_000,
        started_at: '2026-05-10T11:00:00Z',
      }),
    ];
    const stats = computeStats(rows, 'all', {
      now: NOW,
      currentEnergyWh: () => 8_000,
    });
    expect(stats.totalEnergyKwh).toBe(0);
  });
});
