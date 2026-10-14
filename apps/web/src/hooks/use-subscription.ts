import { useEffect, useState } from 'react';

import {
  applySubscriptionDelta,
  retainUnavailableConnectors,
  type DeltaForQuery,
  type QueryName,
  type QueryParams,
  type SnapshotForQuery,
} from '@eveys-console/protocol';

import { useConsoleClient } from '../lib/ws-context';

export interface SubscriptionState<S, D> {
  loading: boolean;
  error: string | null;
  snapshot: S | null;
  lastDelta: D | null;
  cursor: string | null;
}

export function useSubscription<S extends SnapshotForQuery, D extends DeltaForQuery>(
  query: QueryName,
  params: QueryParams,
): SubscriptionState<S, D> {
  const { client, status } = useConsoleClient();
  const paramsKey = JSON.stringify(params);
  const scopeKey = `${query}:${paramsKey}`;
  const emptyState: SubscriptionState<S, D> = {
    loading: true,
    error: null,
    snapshot: null,
    lastDelta: null,
    cursor: null,
  };
  const [scoped, setScoped] = useState({ client, scopeKey, state: emptyState });

  useEffect(() => {
    setScoped((prev) => {
      if (prev.client === client && prev.scopeKey === scopeKey) return prev;
      // No render is needed when the old scope is already empty. This also
      // avoids a reset-driven loop in consumers whose client is not stable.
      if (
        prev.scopeKey === scopeKey &&
        !prev.state.snapshot &&
        !prev.state.error &&
        !prev.state.lastDelta &&
        !prev.state.cursor
      )
        return prev;
      return { client, scopeKey, state: emptyState };
    });
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const setState = (update: (prev: SubscriptionState<S, D>) => SubscriptionState<S, D>) => {
      setScoped((prev) => ({
        client,
        scopeKey,
        state: update(
          prev.client === client && prev.scopeKey === scopeKey ? prev.state : emptyState,
        ),
      }));
    };

    void client
      .subscribe(query, params, {
        onSnapshot: (snapshot, cursor) => {
          if (cancelled) return;
          if (
            snapshot.kind !== query ||
            (snapshot.kind === 'charge-point' && snapshot.row.cp_id !== params.cp_id)
          )
            return;
          setState((prev) => ({
            loading: false,
            error: null,
            lastDelta: null,
            snapshot: retainUnavailableConnectors(prev.snapshot, snapshot) as S,
            cursor,
          }));
        },
        onDelta: (delta, cursor) => {
          if (cancelled) return;
          if (
            delta.kind !== query ||
            (delta.kind === 'charge-point' && delta.row.cp_id !== params.cp_id)
          )
            return;
          setState((prev) => {
            const snapshot = applySubscriptionDelta(prev.snapshot, delta) as S | null;
            // Pages still exposing lastDelta receive the merged row as well.
            let mergedDelta: DeltaForQuery = delta;
            if (delta.kind === 'charge-point' && snapshot?.kind === 'charge-point')
              mergedDelta = { ...delta, row: snapshot.row };
            if (delta.kind === 'charge-points' && delta.row && snapshot?.kind === 'charge-points') {
              mergedDelta = {
                ...delta,
                row: snapshot.rows.find((row) => row.cp_id === delta.row?.cp_id) ?? delta.row,
              };
            }
            return { ...prev, error: null, snapshot, lastDelta: mergedDelta as D, cursor };
          });
        },
        onError: (msg) => {
          if (cancelled) return;
          setState((prev) => ({ ...prev, error: msg, loading: false }));
        },
      })
      .then((handle) => {
        if (cancelled) {
          handle.unsubscribe();
          return;
        }
        unsub = handle.unsubscribe;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'subscription failed',
        }));
      });

    return () => {
      cancelled = true;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, query, paramsKey]);

  if (scoped.client !== client || scoped.scopeKey !== scopeKey) return emptyState;
  if (status !== 'open' && scoped.state.snapshot) {
    return {
      ...scoped.state,
      error: scoped.state.error ?? 'Live updates disconnected. Showing last known data.',
    };
  }
  return scoped.state;
}
