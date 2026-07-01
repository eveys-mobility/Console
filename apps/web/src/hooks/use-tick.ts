// Force a re-render on a fixed cadence. Meant for stateless clock-
// dependent displays (relative-time badges, uptime chips) that would
// otherwise sit frozen until the parent pushes a fresh prop.
//
// Uses a shared singleton clock via `useSyncExternalStore` so N
// consumers pay the cost of ONE interval, not N — matters on the
// fleet list page where a couple dozen TimeAgo cells share the clock.

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (intervalId == null) {
    intervalId = setInterval(() => {
      tick += 1;
      for (const l of listeners) l();
    }, 1_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

/** Subscribe to a shared 1 s clock. Returns a monotonically-
 *  increasing counter; the value itself isn't meaningful, but it
 *  changes every second so the component re-renders. */
export function useTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
