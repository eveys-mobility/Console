// REST client for the "OCPP config" page.
//
// Two surfaces:
//
//   - Fleet-wide post-boot keys (HeartbeatInterval, MeterValuesSampledData,
//     etc.) live in the gateway's runtime-overrides store, reached via the
//     existing `/sys/gateway-admin-config` proxy. The constants in
//     OCPP_FIELDS describe how the UI renders each key.
//
//   - Per-charger `charger_type` ('ac' | 'dc' | null) is the AC/DC flag
//     the gateway reads at boot to pick the right measurand list. The
//     PATCH endpoint is proxied via /sys/charge-points/:cp_id/type.

import { CONSOLE_BASE_URL as BASE } from '@/lib/console-url';

export type ChargerType = 'ac' | 'dc' | null;

export interface ChargerTypeResponse {
  cp_id: string;
  charger_type: ChargerType;
}

/** OCPP key descriptors the OCPP-config page renders. The Gateway
 *  exposes more than these via the admin allowlist, but the OCPP
 *  page is intentionally focused on the post-boot ChangeConfiguration
 *  matrix — webhook / log-level / rate-limit overrides live on the
 *  general Configuration page. */
export type OcppFieldKind = 'int' | 'csv';

export interface OcppFieldSpec {
  /** Field name in the gateway's runtime-override allowlist. */
  key: string;
  /** Human label rendered in the form. */
  label: string;
  /** OCPP wire name the gateway pushes via ChangeConfiguration. */
  ocppKey: string;
  kind: OcppFieldKind;
  /** Section heading the field renders under. */
  section: 'common' | 'ac' | 'dc';
  /** Optional context shown beneath the input. */
  hint?: string;
}

export const OCPP_FIELDS: readonly OcppFieldSpec[] = [
  {
    key: 'meter_value_sample_interval_seconds',
    ocppKey: 'MeterValueSampleInterval',
    label: 'MeterValueSampleInterval (seconds)',
    kind: 'int',
    section: 'common',
    hint: 'Interval between MeterValues samples during a transaction.',
  },
  {
    key: 'ocpp_cfg_heartbeat_interval_seconds',
    ocppKey: 'HeartbeatInterval',
    label: 'HeartbeatInterval (seconds)',
    kind: 'int',
    section: 'common',
    hint: 'Heartbeat cadence. Online TTL is 2× this in the gateway.',
  },
  {
    key: 'ocpp_cfg_connection_time_out_seconds',
    ocppKey: 'ConnectionTimeOut',
    label: 'ConnectionTimeOut (seconds)',
    kind: 'int',
    section: 'common',
    hint: 'Connector reservation window after Authorize.',
  },
  {
    key: 'ocpp_cfg_websocket_ping_interval_seconds',
    ocppKey: 'WebSocketPingInterval',
    label: 'WebSocketPingInterval (seconds)',
    kind: 'int',
    section: 'common',
  },
  {
    key: 'ocpp_cfg_transaction_message_attempts',
    ocppKey: 'TransactionMessageAttempts',
    label: 'TransactionMessageAttempts',
    kind: 'int',
    section: 'common',
  },
  {
    key: 'ocpp_cfg_transaction_message_retry_interval_seconds',
    ocppKey: 'TransactionMessageRetryInterval',
    label: 'TransactionMessageRetryInterval (seconds)',
    kind: 'int',
    section: 'common',
  },
  {
    key: 'ocpp_cfg_meter_values_aligned_data_ac',
    ocppKey: 'MeterValuesAlignedData',
    label: 'MeterValuesAlignedData',
    kind: 'csv',
    section: 'ac',
  },
  {
    key: 'ocpp_cfg_meter_values_sampled_data_ac',
    ocppKey: 'MeterValuesSampledData',
    label: 'MeterValuesSampledData',
    kind: 'csv',
    section: 'ac',
  },
  {
    key: 'ocpp_cfg_stop_txn_aligned_data_ac',
    ocppKey: 'StopTxnAlignedData',
    label: 'StopTxnAlignedData',
    kind: 'csv',
    section: 'ac',
  },
  {
    key: 'ocpp_cfg_stop_txn_sampled_data_ac',
    ocppKey: 'StopTxnSampledData',
    label: 'StopTxnSampledData',
    kind: 'csv',
    section: 'ac',
  },
  {
    key: 'ocpp_cfg_meter_values_aligned_data_dc',
    ocppKey: 'MeterValuesAlignedData',
    label: 'MeterValuesAlignedData',
    kind: 'csv',
    section: 'dc',
  },
  {
    key: 'ocpp_cfg_meter_values_sampled_data_dc',
    ocppKey: 'MeterValuesSampledData',
    label: 'MeterValuesSampledData',
    kind: 'csv',
    section: 'dc',
  },
  {
    key: 'ocpp_cfg_stop_txn_aligned_data_dc',
    ocppKey: 'StopTxnAlignedData',
    label: 'StopTxnAlignedData',
    kind: 'csv',
    section: 'dc',
  },
  {
    key: 'ocpp_cfg_stop_txn_sampled_data_dc',
    ocppKey: 'StopTxnSampledData',
    label: 'StopTxnSampledData',
    kind: 'csv',
    section: 'dc',
  },
];

export async function setChargerType(
  token: string,
  cpId: string,
  chargerType: ChargerType,
): Promise<ChargerTypeResponse> {
  const res = await fetch(
    `${BASE}/sys/charge-points/${encodeURIComponent(cpId)}/type`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ charger_type: chargerType }),
    },
  );
  if (!res.ok) {
    let message = `charge-points/${cpId}/type ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string }; detail?: string };
      if (body?.error?.message) message = body.error.message;
      else if (body?.detail) message = body.detail;
    } catch {
      /* fall through */
    }
    throw new Error(message);
  }
  return (await res.json()) as ChargerTypeResponse;
}
