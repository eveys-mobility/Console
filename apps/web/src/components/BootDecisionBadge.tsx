// Badge + notice for a charger whose last BootNotification was not
// Accepted. Both render nothing when there is nothing to say, so call
// sites can drop them in unconditionally.

import { AlertTriangle } from 'lucide-react';

import type { ChargePointSummary } from '@eveys-console/protocol';

import { TimeAgo } from '@/components/TimeAgo';
import { Badge } from '@/components/ui/badge';
import { describeBootDecision } from '@/lib/boot-decision';
import { cn } from '@/lib/utils';

export function BootDecisionBadge({
  cp,
  className,
  'data-testid': testId,
}: {
  cp: ChargePointSummary;
  className?: string;
  'data-testid'?: string;
}) {
  const d = describeBootDecision(cp);
  if (!d) return null;
  return (
    <Badge
      variant={d.tone}
      className={cn('font-mono text-xs', className)}
      title={`${d.title}. ${d.detail}`}
      data-testid={testId}
    >
      {d.label}
    </Badge>
  );
}

export function BootDecisionNotice({ cp }: { cp: ChargePointSummary }) {
  const d = describeBootDecision(cp);
  if (!d) return null;
  return (
    <div
      role="status"
      data-testid="boot-decision-notice"
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        d.tone === 'destructive'
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300',
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-0.5">
        <p className="font-medium">{d.title}</p>
        <p className="text-xs opacity-90">{d.detail}</p>
        {d.decidedAt ? (
          <p className="text-xs opacity-70">
            Last answered <TimeAgo iso={d.decidedAt} />
            {d.reason ? <span className="font-mono"> · {d.reason}</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
