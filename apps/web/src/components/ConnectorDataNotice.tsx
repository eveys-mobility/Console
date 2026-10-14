import { withConnectorFreshness } from '@eveys-console/protocol';
import type { ChargePointSummary } from '@eveys-console/protocol';

import { TimeAgo } from '@/components/TimeAgo';

function displayedConnectors(cp: ChargePointSummary) {
  return withConnectorFreshness(cp).connectors.map((connector) =>
    connector.status_freshness === 'current'
      ? connector
      : { ...connector, reported_status: connector.status, status: 'Unknown' },
  );
}

export function physicalConnectors(cp: ChargePointSummary) {
  return displayedConnectors(cp).filter((connector) => connector.connector_id > 0);
}

export function controllerConnector(cp: ChargePointSummary) {
  return displayedConnectors(cp).find((connector) => connector.connector_id === 0);
}

export function ConnectorDataNotice({ cp }: { cp: ChargePointSummary }) {
  const stale = withConnectorFreshness(cp).connectors.filter(
    (connector) => connector.status_freshness !== 'current',
  );
  if (cp.connectors_state !== 'unavailable' && stale.length === 0) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
      {stale.length > 0 ? (
        <>
          Current connector status is unknown. Awaiting a newer status notification. Last reported:{' '}
          {stale.map((connector) => `${connector.connector_id}: ${connector.status}`).join(', ')}.
        </>
      ) : (
        <>
          Connector data unavailable.
          {physicalConnectors(cp).length > 0
            ? ' Showing last known or live connector states.'
            : ' Connector count is unknown.'}
        </>
      )}
      {cp.connectors_last_successful_at ? (
        <span>
          {' '}
          Last successful read: <TimeAgo iso={cp.connectors_last_successful_at} />.
        </span>
      ) : null}
    </p>
  );
}
