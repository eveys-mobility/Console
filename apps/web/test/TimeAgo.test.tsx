import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimeAgo } from '@/components/TimeAgo';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('TimeAgo', () => {
  it('renders relative time and a local-zone absolute in the title attribute', () => {
    render(<TimeAgo iso="2026-05-10T11:48:00.000Z" />);
    const node = screen.getByTestId('time-ago');
    expect(node.textContent).toBe('12m ago');
    // Local-zone — test runner's TZ varies; just assert the shape:
    // `YYYY-MM-DD HH:MM:SS ±HH:MM`.
    expect(node.getAttribute('title')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/,
    );
  });

  it('renders the em-dash without a title attribute when iso is null', () => {
    render(<TimeAgo iso={null} />);
    const node = screen.getByTestId('time-ago');
    expect(node.textContent).toBe('—');
    expect(node.getAttribute('title')).toBeNull();
  });

  it('renders the em-dash without a title attribute for unparseable iso', () => {
    render(<TimeAgo iso="not-a-date" />);
    const node = screen.getByTestId('time-ago');
    expect(node.textContent).toBe('—');
    expect(node.getAttribute('title')).toBeNull();
  });

  it('applies the className prop', () => {
    render(<TimeAgo iso="2026-05-10T11:00:00.000Z" className="text-xs" />);
    const node = screen.getByTestId('time-ago');
    expect(node.className).toContain('text-xs');
  });
});
