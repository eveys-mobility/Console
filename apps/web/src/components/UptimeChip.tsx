// "Uptime: 99.7% (30d)" chip on the charger detail page header.
//
// Distinct from the boot-uptime badge next to it (which shows "how
// long since this charger last booted"). This chip is the
// **operational uptime percentage** computed from completed offline
// intervals over a date range — the question "was this charger
// actually reachable last month?".
//
// Backed by /sys/charge-points/:cp_id/uptime, which proxies the
// gateway. Defaults to a 30-day window; clicking the chip reveals
// 7d / 30d / 90d switches + a per-interval breakdown.
//
// Refetch triggers:
//   - operator picks a different window
//   - the charger's WS comes back online (caller bumps `refetchKey`)

import { Loader2, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { fetchCpUptime, type UptimeResponse } from '@/api/uptime-client';
import { useConsoleClient } from '@/lib/ws-context';
import { cn } from '@/lib/utils';

type WindowDays = 7 | 30 | 90;
const WINDOW_OPTIONS: ReadonlyArray<{ days: WindowDays; label: string }> = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

export interface UptimeChipProps {
  cpId: string;
  /** When the charger flips online, callers pass a fresh value so the
   *  effect re-fetches. Any monotonic identity works — the row's
   *  `last_boot_at` is a natural choice. */
  refetchKey?: string | null;
}

export function UptimeChip({ cpId, refetchKey = null }: UptimeChipProps) {
  const { token } = useConsoleClient();
  const [days, setDays] = useState<WindowDays>(30);
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'ok'; data: UptimeResponse }
    | { phase: 'error'; detail: string }
  >({ phase: 'loading' });

  const window = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  useEffect(() => {
    // No JWT yet (initial load before sign-in completes) — wait for
    // the token to arrive. The chip stays in `loading` state until
    // then; the effect re-runs once `token` becomes a string.
    if (!token) return;
    let cancelled = false;
    setState({ phase: 'loading' });
    fetchCpUptime(token, cpId, window)
      .then((data) => {
        if (!cancelled) setState({ phase: 'ok', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          phase: 'error',
          detail: err instanceof Error ? err.message : 'request failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [cpId, token, window, refetchKey]);

  // Close the panel on outside click. Esc closes too.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (state.phase === 'loading') {
    return (
      <Badge variant="secondary" className="font-mono text-xs" data-testid="uptime-chip">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        uptime
      </Badge>
    );
  }
  if (state.phase === 'error') {
    return (
      <Badge
        variant="secondary"
        className="font-mono text-xs text-muted-foreground"
        title={state.detail}
        data-testid="uptime-chip"
      >
        <TriangleAlert className="mr-1 h-3 w-3" />
        uptime: —
      </Badge>
    );
  }

  const pct = state.data.uptime_pct;
  const pctText = formatUptimePct(pct, state.data.offline_seconds_total);
  // Three buckets: green ≥ 99.9, amber ≥ 99, red < 99. Revisit once
  // the ops team writes an SLA target; these are operator-readable
  // defaults, not tuned to any contract.
  const tone =
    pct >= 99.9
      ? 'text-emerald-700 dark:text-emerald-400'
      : pct >= 99
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-destructive';

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        aria-expanded={open}
        aria-controls="uptime-chip-popover"
        data-testid="uptime-chip"
      >
        <Badge
          variant="secondary"
          className={cn('cursor-pointer font-mono text-xs', tone)}
          title="Click for details. Excludes any in-flight outage."
        >
          <ShieldCheck className="mr-1 h-3 w-3" />
          uptime: {pctText} ({days}d)
        </Badge>
      </button>
      {open ? (
        <div
          id="uptime-chip-popover"
          role="dialog"
          aria-label="Uptime details"
          className="absolute z-30 mt-2 w-[320px] space-y-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
          data-testid="uptime-chip-popover"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Window
            </span>
            <div className="flex items-center gap-1">
              <div className="inline-flex rounded-md border bg-background p-0.5">
                {WINDOW_OPTIONS.map((opt) => (
                  <button
                    key={opt.days}
                    type="button"
                    onClick={() => setDays(opt.days)}
                    className={cn(
                      'rounded-sm px-2 py-0.5 text-xs',
                      opt.days === days ? 'bg-foreground text-background' : 'text-muted-foreground',
                    )}
                    data-testid={`uptime-window-${opt.days}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-muted-foreground hover:bg-muted"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div>
            <div className={cn('text-2xl font-semibold', tone)}>{pctText}</div>
            <div className="text-xs text-muted-foreground">
              offline for {formatSeconds(state.data.offline_seconds_total)} of{' '}
              {formatSeconds(state.data.window.seconds)}
            </div>
          </div>
          {state.data.intervals.length > 0 ? (
            <div className="max-h-[180px] overflow-y-auto rounded border bg-muted/30">
              <ul className="divide-y text-xs">
                {state.data.intervals.map((iv, i) => (
                  <li key={i} className="px-2 py-1.5">
                    <div className="font-mono">{formatSeconds(iv.offline_seconds)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {iv.went_offline_at.slice(0, 16).replace('T', ' ')} →{' '}
                      {iv.came_online_at.slice(0, 16).replace('T', ' ')}
                    </div>
                    {iv.prior_reason ? (
                      <div
                        className="text-[10px] text-muted-foreground"
                        title={uptimeReasonHelp(iv.prior_reason)}
                      >
                        reason: {formatUptimeReason(iv.prior_reason)}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No outages in this window.</div>
          )}
          <p className="text-[10px] text-muted-foreground">
            In-flight outages aren&apos;t counted; pair with the live online flag.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Render a seconds count as a compact human string. The popover has
 *  limited width so we collapse to the largest unit that fits — no
 *  millisecond precision, no full "1d 3h 27m 14s" sprawl. */
function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** Display uptime % with enough precision to keep recorded outages
 *  visible. The gateway clamps `uptime_pct` to 4 decimal places; rounding
 *  to 2 decimals turns 99.9974 % (≈68 s of outage in 30 d) into 100.00 %,
 *  which misleads operators who can see the outages listed below the
 *  number. Rule: when there ARE recorded offline seconds, never show
 *  exactly 100.00 % — fall back to as many decimals as the gateway gives
 *  us, and cap at "<99.9999%" so the operator at least sees the inequality. */
function formatUptimePct(pct: number, offlineSeconds: number): string {
  if (offlineSeconds <= 0) return `${pct.toFixed(2)}%`;
  // There IS recorded downtime — refuse to show 100.00 %.
  const twoDp = pct.toFixed(2);
  if (twoDp !== '100.00') return `${twoDp}%`;
  // 4 dp is the gateway's resolution (see api/timeseries.py:552). If
  // even 4 dp still rounds to 100.0000 (sub-second outage), fall back
  // to the inequality form instead of lying.
  const fourDp = pct.toFixed(4);
  if (fourDp === '100.0000') return '<99.9999%';
  return `${fourDp}%`;
}

/** The gateway records two disconnect reasons today:
 *  - `clean`: the WS task returned normally (charger closed cleanly).
 *  - `error`: an unhandled exception terminated the WS task (network
 *    drop, protocol error, broker hiccup, server bug).
 *  "error" reads like a charger-side fault to operators — it isn't.
 *  Map to plain language; the title attribute carries the full
 *  explanation. */
function formatUptimeReason(raw: string): string {
  switch (raw) {
    case 'error':
      return 'connection lost';
    case 'clean':
      return 'graceful disconnect';
    default:
      return raw;
  }
}

function uptimeReasonHelp(raw: string): string {
  switch (raw) {
    case 'error':
      return 'The WebSocket session terminated abnormally — typically a network drop, TLS reset, or transient backend error. Not a charger-side fault by itself.';
    case 'clean':
      return 'The charger closed the WebSocket gracefully (firmware reboot, maintenance, scheduled idle).';
    default:
      return raw;
  }
}
