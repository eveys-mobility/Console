// Page-lifetime ring buffer of OCPP commands the operator sent and
// the charger's responses. The transcript is the feedback for a
// command (replaces the "Command accepted by charger" toast which
// hid the actual response).
//
// Persistence model — IMPORTANT:
//   The ring is held in a module-level Map keyed by cp_id, NOT in
//   React component state. That way switching between the Commands /
//   Events / Connectors tabs on the same charger (or navigating
//   away to /inspect/charge-points and back) keeps the transcript
//   intact for the session lifetime. The map is process-local; a
//   hard refresh or sign-out drops it — this is session state, not
//   a server log. Each cp_id has its own ring so a different
//   charger doesn't see another's history.
//
// Implementation: each store is a small subscription target. The
// `useCommandTranscript` hook attaches via `useSyncExternalStore`
// and re-renders on every snapshot bump. The store mutates in
// place and notifies listeners.

import { useCallback, useSyncExternalStore } from 'react';

import type { ConsoleClient } from '@/api/ws-client';
import { describeCommandResponse } from '@/lib/command-outcome';

const RING_CAP = 200;

export type TranscriptPhase = 'pending' | 'ok' | 'error';

/** Coarse outcome bucket derived from the charger response. Mirrors
 *  the OCPP spec's three families (Accepted / soft-reject /
 *  hard-reject) so the UI can colour-code without inspecting per-
 *  command-specific fields. */
export type TranscriptOutcome =
  | 'accepted'
  | 'rejected'
  | 'soft-reject' // Occupied / Unavailable / Faulted / NotImplemented / NotSupported / Failed
  | 'pending'
  | 'unknown'
  | 'error';

export interface TranscriptEntry {
  /** Monotonic counter — stable React key. */
  id: number;
  startedAt: string;
  method: string;
  request: Record<string, unknown>;
  phase: TranscriptPhase;
  response?: unknown;
  /** Compact one-line label derived from the response shape. */
  status?: string;
  /** Coarse bucket for colour-coding. */
  outcome: TranscriptOutcome;
  elapsedMs?: number;
  error?: string;
}

export interface UseCommandTranscript {
  entries: TranscriptEntry[];
  paused: boolean;
  bufferedCount: number;
  send: (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: unknown) => void,
  ) => Promise<void>;
  /** Method names currently in-flight; the forms use this to disable
   *  the Send button while a request is pending. */
  inFlight: Set<string>;
  clear: () => void;
  pause: () => void;
  resume: () => void;
}

// ---------------------------------------------------------------------------
// Per-cp_id store
// ---------------------------------------------------------------------------

interface Snapshot {
  entries: TranscriptEntry[];
  inFlight: Set<string>;
  paused: boolean;
  bufferedCount: number;
}

class TranscriptStore {
  private entries: TranscriptEntry[] = [];
  private inFlight = new Set<string>();
  private paused = false;
  /** Buffered completion patches while paused, keyed by entry id. */
  private pauseBuffer = new Map<number, Partial<TranscriptEntry>>();
  private nextId = 1;
  private listeners = new Set<() => void>();
  /** Snapshot reference — replaced (not mutated) on every change so
   *  React's `useSyncExternalStore` sees a new identity. */
  private snapshot: Snapshot = {
    entries: [],
    inFlight: new Set(),
    paused: false,
    bufferedCount: 0,
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private notify(): void {
    this.snapshot = {
      entries: this.entries.slice(),
      inFlight: new Set(this.inFlight),
      paused: this.paused,
      bufferedCount: this.pauseBuffer.size,
    };
    for (const l of this.listeners) l();
  }

  begin(method: string, request: Record<string, unknown>): number {
    const id = this.nextId++;
    const startedAt = new Date().toISOString();
    const entry: TranscriptEntry = {
      id,
      startedAt,
      method,
      request,
      phase: 'pending',
      outcome: 'pending',
    };
    this.entries = [entry, ...this.entries].slice(0, RING_CAP);
    this.inFlight.add(method);
    this.notify();
    return id;
  }

  complete(id: number, method: string, patch: Partial<TranscriptEntry>): void {
    if (this.paused) {
      // Buffer the patch so the visible entry stays "pending" until
      // Resume; the form button still re-enables since the method is
      // no longer in-flight.
      this.pauseBuffer.set(id, patch);
      this.dropMethodIfDone(id, method);
      this.notify();
      return;
    }
    this.applyPatch(id, patch);
    this.dropMethodIfDone(id, method);
    this.notify();
  }

  private applyPatch(id: number, patch: Partial<TranscriptEntry>): void {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
  }

  private dropMethodIfDone(completedId: number, method: string): void {
    const stillPending = this.entries.some(
      (e) => e.id !== completedId && e.method === method && e.phase === 'pending',
    );
    if (!stillPending) this.inFlight.delete(method);
  }

  clear(): void {
    this.entries = [];
    this.pauseBuffer.clear();
    this.notify();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.notify();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pauseBuffer.size > 0) {
      for (const [id, patch] of this.pauseBuffer) {
        this.applyPatch(id, patch);
      }
      this.pauseBuffer.clear();
    }
    this.notify();
  }
}

/** Module-level registry. Survives component unmount / remount for
 *  the session lifetime. Cleared on page reload (browser drops the
 *  module). */
const STORES = new Map<string, TranscriptStore>();

function getStore(cpId: string): TranscriptStore {
  let s = STORES.get(cpId);
  if (!s) {
    s = new TranscriptStore();
    STORES.set(cpId, s);
  }
  return s;
}

/** Test-only: drop every store. Vitest runs share a worker, so the
 *  module-level map needs to be wiped between specs to avoid one
 *  test leaking entries into the next. */
export function __resetTranscriptStoresForTests(): void {
  STORES.clear();
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCommandTranscript(
  client: Pick<ConsoleClient, 'rpc'>,
  cpId: string,
): UseCommandTranscript {
  const store = getStore(cpId);
  const snap = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const send = useCallback(
    async (method: string, params: Record<string, unknown>, onResult?: (r: unknown) => void) => {
      const request = { cp_id: cpId, ...params };
      const id = store.begin(method, request);
      const startMs = performance.now();
      try {
        const response = await client.rpc(method, request);
        const elapsedMs = Math.round(performance.now() - startMs);
        const { status, outcome } = describeCommandResponse(method, response);
        store.complete(id, method, { phase: 'ok', response, status, outcome, elapsedMs });
        if (outcome === 'accepted') onResult?.(response);
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - startMs);
        const message = err instanceof Error ? err.message : 'rpc failed';
        store.complete(id, method, {
          phase: 'error',
          outcome: 'error',
          error: message,
          status: message,
          elapsedMs,
        });
      }
    },
    [client, cpId, store],
  );

  const clear = useCallback(() => store.clear(), [store]);
  const pause = useCallback(() => store.pause(), [store]);
  const resume = useCallback(() => store.resume(), [store]);

  return {
    entries: snap.entries,
    inFlight: snap.inFlight,
    paused: snap.paused,
    bufferedCount: snap.bufferedCount,
    send,
    clear,
    pause,
    resume,
  };
}
