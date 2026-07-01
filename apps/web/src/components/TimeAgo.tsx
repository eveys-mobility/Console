// Tiny wrapper that renders a relative-time string ("12m ago") and
// exposes the absolute UTC timestamp as a tooltip via the `title`
// attribute. Pairs `formatRelativeTime` + `formatAbsoluteTime` so call
// sites stay tight.
//
// Renders an em-dash for null/unparseable input — same shape as the
// underlying helpers — so the call site doesn't need a null check.
//
// Self-ticks on a shared 1 s clock so "12s ago" advances to "13s ago"
// even when the parent hasn't re-rendered — needed on surfaces like
// the charger-detail toolbar where the underlying prop only changes
// on a Kafka event (boot/status), not on the wall clock.

import { useTick } from '@/hooks/use-tick';
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

interface Props {
  iso: string | null | undefined;
  /** Extra classes on the wrapper. */
  className?: string;
}

export function TimeAgo({ iso, className }: Props) {
  useTick();
  const rel = formatRelativeTime(iso);
  const abs = formatAbsoluteTime(iso);
  // When the timestamp is null / unparseable, both helpers return '—'.
  // Skip the tooltip so the user doesn't see "—" as the hover detail.
  const title = rel === '—' ? undefined : abs;
  return (
    <span className={cn(className)} title={title} data-testid="time-ago">
      {rel}
    </span>
  );
}
