import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatAbsoluteTime,
  formatDurationMinutes,
  formatRelativeTime,
  formatUptime,
} from '@/lib/time';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('formatRelativeTime', () => {
  it('returns em-dash for null / undefined / unparseable', () => {
    expect(formatRelativeTime(null)).toBe('—');
    expect(formatRelativeTime(undefined)).toBe('—');
    expect(formatRelativeTime('not-a-date')).toBe('—');
  });

  it('uses second precision under a minute', () => {
    expect(formatRelativeTime('2026-05-10T11:59:30.000Z')).toBe('30s ago');
  });

  it('says "now" for sub-5s', () => {
    expect(formatRelativeTime('2026-05-10T11:59:58.000Z')).toBe('now');
  });

  it('switches to minutes / hours / days as the gap grows', () => {
    expect(formatRelativeTime('2026-05-10T11:55:00.000Z')).toBe('5m ago');
    expect(formatRelativeTime('2026-05-10T09:00:00.000Z')).toBe('3h ago');
    expect(formatRelativeTime('2026-05-08T12:00:00.000Z')).toBe('2d ago');
  });
});

describe('formatUptime', () => {
  it('returns em-dash for null / undefined / unparseable / future', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(undefined)).toBe('—');
    expect(formatUptime('not-a-date')).toBe('—');
    // Future timestamp (clock skew) — treat as unknown rather than negative.
    expect(formatUptime('2026-05-10T13:00:00.000Z')).toBe('—');
  });

  it('renders sub-minute as seconds', () => {
    expect(formatUptime('2026-05-10T11:59:15.000Z')).toBe('45s');
  });

  it('renders sub-hour as a single minute count', () => {
    expect(formatUptime('2026-05-10T11:48:00.000Z')).toBe('12m');
  });

  it('renders sub-day as Xh Ym, omitting minutes when 0', () => {
    expect(formatUptime('2026-05-10T09:46:00.000Z')).toBe('2h 14m');
    expect(formatUptime('2026-05-10T09:00:00.000Z')).toBe('3h');
  });

  it('renders multi-day as Xd Yh, omitting hours when 0', () => {
    expect(formatUptime('2026-05-07T08:00:00.000Z')).toBe('3d 4h');
    expect(formatUptime('2026-05-07T12:00:00.000Z')).toBe('3d');
  });
});

describe('formatDurationMinutes', () => {
  it('returns em-dash for non-finite or negative input', () => {
    expect(formatDurationMinutes(Number.NaN)).toBe('—');
    expect(formatDurationMinutes(-1)).toBe('—');
    expect(formatDurationMinutes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('renders sub-minute as seconds', () => {
    expect(formatDurationMinutes(45_000)).toBe('45s');
  });

  it('renders sub-hour as a single minute count', () => {
    expect(formatDurationMinutes(12 * 60_000)).toBe('12m');
  });

  it('renders sub-day as Xh Ym, omitting minutes when 0', () => {
    expect(formatDurationMinutes(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(formatDurationMinutes(3 * 3_600_000)).toBe('3h');
  });

  it('renders multi-day as Xd Yh, omitting hours when 0', () => {
    expect(formatDurationMinutes(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatDurationMinutes(3 * 86_400_000)).toBe('3d');
  });
});

describe('formatAbsoluteTime', () => {
  // Render in the browser's local zone — the operator sees their own
  // wall clock. Mock getTimezoneOffset so the assertions are
  // independent of the test runner's TZ env (CI defaults to UTC).

  it('returns em-dash for null / undefined / unparseable', () => {
    expect(formatAbsoluteTime(null)).toBe('—');
    expect(formatAbsoluteTime(undefined)).toBe('—');
    expect(formatAbsoluteTime('not-a-date')).toBe('—');
  });

  it('renders in local zone with offset suffix', () => {
    // Pretend we're in +03:00. The input is 17:19 UTC ⇒ 20:19 local.
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-180);
    try {
      const out = formatAbsoluteTime('2026-05-10T17:19:25.000Z');
      // Don't pin the exact local hours — getHours() in the test
      // process still consults the real OS TZ; just assert structure.
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+03:00$/);
    } finally {
      spy.mockRestore();
    }
  });

  it('renders a negative offset with a leading minus', () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(300);
    try {
      const out = formatAbsoluteTime('2026-05-10T17:19:25.000Z');
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -05:00$/);
    } finally {
      spy.mockRestore();
    }
  });

  it('pads single-digit month/day/hour/min/sec', () => {
    // Test runner's TZ is whatever the host OS is set to, so we can't
    // pin the hours portion. Assert the YYYY-MM-DD and shape.
    const out = formatAbsoluteTime('2026-01-05T03:04:05.000Z');
    expect(out).toMatch(/^2026-01-05 \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  });
});
