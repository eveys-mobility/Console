import type { ChargePointSummary } from '@eveys-console/protocol';

import { TimeAgo } from '@/components/TimeAgo';

export function physicalConnectors(cp: ChargePointSummary) {
  return cp.connectors.filter((connector) => connector.connector_id > 0);
}

export function ConnectorDataNotice({ cp }: { cp: ChargePointSummary }) {
  if (cp.connectors_state !== 'unavailable') return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
      Connector data unavailable.
      {physicalConnectors(cp).length > 0
        ? ' Showing last known or live connector states.'
        : ' Connector count is unknown.'}
      {cp.connectors_last_successful_at ? (
        <span>
          {' '}
          Last successful read: <TimeAgo iso={cp.connectors_last_successful_at} />.
        </span>
      ) : null}
    </p>
  );
}
