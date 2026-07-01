// Self-ticking uptime display. Same shape as TimeAgo, but formats
// via `formatUptime` — "45s" / "12m" / "2h 14m" / "3d 4h" — so a
// live "since boot" badge advances every second without the parent
// having to re-render.

import { useTick } from '@/hooks/use-tick';
import { formatAbsoluteTime, formatUptime } from '@/lib/time';
import { cn } from '@/lib/utils';

interface Props {
  iso: string | null | undefined;
  /** Extra classes on the wrapper. */
  className?: string;
}

export function Uptime({ iso, className }: Props) {
  useTick();
  const uptime = formatUptime(iso);
  const abs = formatAbsoluteTime(iso);
  const title = uptime === '—' ? undefined : abs;
  return (
    <span className={cn(className)} title={title} data-testid="uptime">
      {uptime}
    </span>
  );
}
