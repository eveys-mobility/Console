// Live per-transaction telemetry keyed by (connector_id, tx_id).
// Populated from the meter-history subscription on a single cp_id.
// Consumers pick the matching slot to render current kW / SoC / Wh
// for the active session without waiting for their REST poll to
// come around.
//
// Used by both the per-charger Transactions history card (row-level
// kW / SoC / kWh) and the Statistics card (rolling total energy
// includes the delivered-so-far Wh on any open session).

import { useEffect, useRef, useState } from 'react';

import { useSubscription } from '@/hooks/use-subscription';

export interface LiveTelemetry {
  /** kW computed from POWER_ACTIVE_IMPORT (W) for the active connector. */
  power_kw: number | null;
  /** Battery state of charge, 0–100. */
  soc_pct: number | null;
  /** Latest energy-register Wh value. The row's consumed_wh =
   *  (latest_wh - meter_start_wh) when present. */
  latest_wh: number | null;
  /** When the latest sample arrived — used to flash the row briefly
   *  so a watching operator sees the update. */
  updated_at: string;
}

const LIVE_INITIAL: LiveTelemetry = {
  power_kw: null,
  soc_pct: null,
  latest_wh: null,
  updated_at: '',
};

export function liveTelemetryKey(connectorId: number, txId: number): string {
  return `${connectorId}:${txId}`;
}

export function useLiveTransactionTelemetry(cpId: string): Map<string, LiveTelemetry> {
  const sub = useSubscription('meter-history', { cp_id: cpId });
  const [byKey, setByKey] = useState<Map<string, LiveTelemetry>>(() => new Map());
  const lastSeenRef = useRef<unknown>(null);

  useEffect(() => {
    setByKey(new Map());
    lastSeenRef.current = null;
  }, [cpId]);

  useEffect(() => {
    const delta = sub.lastDelta;
    if (!delta || delta.kind !== 'meter-history') return;
    if (lastSeenRef.current === delta.append) return;
    lastSeenRef.current = delta.append;
    const sample = delta.append;
    if (sample.transaction_id == null) return;
    const key = liveTelemetryKey(sample.connector_id, sample.transaction_id);
    setByKey((prev) => {
      const next = new Map(prev);
      const cur = next.get(key) ?? LIVE_INITIAL;
      const updated: LiveTelemetry = { ...cur, updated_at: sample.recorded_at };
      switch (sample.measurand) {
        case 'POWER_ACTIVE_IMPORT':
          updated.power_kw = sample.value / 1000;
          break;
        case 'SOC':
          updated.soc_pct = sample.value;
          break;
        case 'ENERGY_ACTIVE_IMPORT_REGISTER':
          updated.latest_wh = sample.value;
          break;
        default:
          return prev;
      }
      next.set(key, updated);
      return next;
    });
  }, [sub.lastDelta]);

  return byKey;
}
