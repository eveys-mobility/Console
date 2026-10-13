import type { ChargePointSummary, DeltaForQuery, SnapshotForQuery } from './queries.js';

// A successful archive read does not make a pre-boot notification current.
// Retain the reported value for diagnosis, but mark its usability separately.
export function withConnectorFreshness(row: ChargePointSummary): ChargePointSummary {
  const boot = row.last_boot_at ? Date.parse(row.last_boot_at) : NaN;
  return {
    ...row,
    connectors: row.connectors.map((connector) => {
      const observed = connector.last_changed_at ? Date.parse(connector.last_changed_at) : NaN;
      if (Number.isFinite(boot) && Number.isFinite(observed) && observed < boot) {
        return {
          ...connector,
          status_freshness: 'stale' as const,
          stale_reason: 'before_boot' as const,
        };
      }
      if (!Number.isFinite(boot) || !Number.isFinite(observed)) {
        return {
          ...connector,
          status_freshness: 'unknown' as const,
          stale_reason: 'unverified_timestamp' as const,
        };
      }
      // Preserve additional server evidence (for example a later physical Stop).
      if (connector.status_freshness === 'stale' || connector.status_freshness === 'unknown')
        return connector;
      return { ...connector, status_freshness: 'current' as const, stale_reason: null };
    }),
  };
}

// Gateway refetches can lag the Kafka tail. Keep each connector's newest
// observed value, comparing ISO offsets by their UTC instant.
export function mergeChargePoint(
  previous: ChargePointSummary | undefined,
  incoming: ChargePointSummary,
): ChargePointSummary {
  if (!previous || previous.cp_id !== incoming.cp_id) return withConnectorFreshness(incoming);
  const connectors = new Map(
    previous.connectors.map((connector) => [connector.connector_id, connector]),
  );
  let accepted = false;
  for (const connector of incoming.connectors) {
    const old = connectors.get(connector.connector_id);
    const oldTime = old?.last_changed_at ? Date.parse(old.last_changed_at) : NaN;
    const newTime = connector.last_changed_at ? Date.parse(connector.last_changed_at) : NaN;
    if (old && Number.isFinite(oldTime) && (!Number.isFinite(newTime) || newTime < oldTime))
      continue;
    connectors.set(connector.connector_id, connector);
    accepted = true;
  }
  return withConnectorFreshness({
    ...incoming,
    last_status:
      incoming.connectors.length > 0 && !accepted ? previous.last_status : incoming.last_status,
    connectors: [...connectors.values()].sort((a, b) => a.connector_id - b.connector_id),
    ...(incoming.connectors_state === 'unavailable' && previous.connectors_last_successful_at
      ? { connectors_last_successful_at: previous.connectors_last_successful_at }
      : {}),
  });
}

// Histories keep their existing append consumers. Entity snapshots accumulate
// all upserts/removes here so callers cannot accidentally apply only one delta.
export function applySubscriptionDelta(
  snapshot: SnapshotForQuery | null,
  delta: DeltaForQuery,
): SnapshotForQuery | null {
  if (!snapshot || snapshot.kind !== delta.kind) return snapshot;
  if (snapshot.kind === 'charge-point' && delta.kind === 'charge-point') {
    if (snapshot.row.cp_id !== delta.row.cp_id) return snapshot;
    return { ...snapshot, row: mergeChargePoint(snapshot.row, delta.row) };
  }
  if (snapshot.kind === 'charge-points' && delta.kind === 'charge-points') {
    const rows = new Map(snapshot.rows.map((row) => [row.cp_id, row]));
    if (delta.op === 'remove' && delta.cp_id) rows.delete(delta.cp_id);
    if (delta.op === 'upsert' && delta.row)
      rows.set(delta.row.cp_id, mergeChargePoint(rows.get(delta.row.cp_id), delta.row));
    return { ...snapshot, rows: [...rows.values()] };
  }
  if (snapshot.kind === 'transactions-active' && delta.kind === 'transactions-active') {
    const rows = new Map(snapshot.rows.map((row) => [row.transaction_id, row]));
    if (delta.op === 'remove' && delta.transaction_id !== undefined)
      rows.delete(delta.transaction_id);
    if (delta.op === 'upsert' && delta.row) rows.set(delta.row.transaction_id, delta.row);
    return { ...snapshot, rows: [...rows.values()] };
  }
  return snapshot;
}

// A new successful snapshot is authoritative. An unavailable archive cannot
// erase the last successful connector snapshot on reconnect.
export function retainUnavailableConnectors(
  previous: SnapshotForQuery | null,
  incoming: SnapshotForQuery,
): SnapshotForQuery {
  if (
    previous?.kind === 'charge-point' &&
    incoming.kind === 'charge-point' &&
    incoming.row.connectors_state === 'unavailable'
  ) {
    return { ...incoming, row: mergeChargePoint(previous.row, incoming.row) };
  }
  if (previous?.kind === 'charge-points' && incoming.kind === 'charge-points') {
    const oldRows = new Map(previous.rows.map((row) => [row.cp_id, row]));
    return {
      ...incoming,
      rows: incoming.rows.map((row) =>
        row.connectors_state === 'unavailable'
          ? mergeChargePoint(oldRows.get(row.cp_id), row)
          : row,
      ),
    };
  }
  return incoming;
}
