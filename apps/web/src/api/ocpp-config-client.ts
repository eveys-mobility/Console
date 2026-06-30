// REST client for the "OCPP config" page.
//
// One surface: the gateway's runtime-overrides store, reached via the
// existing `/sys/gateway-admin-config` proxy. OCPP_FIELDS describes
// the type-agnostic keys the gateway pushes after every Accepted
// BootNotification. Measurand-list keys (MeterValuesSampledData,
// StopTxnAlignedData, …) are intentionally NOT included — they
// differ between AC and DC chargers and BootNotification doesn't
// carry a reliable AC/DC signal, so the gateway leaves them to the
// per-charger `ChangeConfiguration` command surface.

export type OcppFieldKind = 'int';

export interface OcppFieldSpec {
  /** Field name in the gateway's runtime-override allowlist. */
  key: string;
  /** Human label rendered in the form. */
  label: string;
  /** OCPP wire name the gateway pushes via ChangeConfiguration. */
  ocppKey: string;
  kind: OcppFieldKind;
  /** Optional context shown beneath the input. */
  hint?: string;
}

export const OCPP_FIELDS: readonly OcppFieldSpec[] = [
  {
    key: 'meter_value_sample_interval_seconds',
    ocppKey: 'MeterValueSampleInterval',
    label: 'MeterValueSampleInterval (seconds)',
    kind: 'int',
    hint: 'Interval between MeterValues samples during a transaction.',
  },
  {
    key: 'ocpp_cfg_heartbeat_interval_seconds',
    ocppKey: 'HeartbeatInterval',
    label: 'HeartbeatInterval (seconds)',
    kind: 'int',
    hint: 'Heartbeat cadence. Online TTL is 2× this in the gateway.',
  },
  {
    key: 'ocpp_cfg_connection_time_out_seconds',
    ocppKey: 'ConnectionTimeOut',
    label: 'ConnectionTimeOut (seconds)',
    kind: 'int',
    hint: 'Connector reservation window after Authorize.',
  },
  {
    key: 'ocpp_cfg_websocket_ping_interval_seconds',
    ocppKey: 'WebSocketPingInterval',
    label: 'WebSocketPingInterval (seconds)',
    kind: 'int',
  },
  {
    key: 'ocpp_cfg_transaction_message_attempts',
    ocppKey: 'TransactionMessageAttempts',
    label: 'TransactionMessageAttempts',
    kind: 'int',
  },
  {
    key: 'ocpp_cfg_transaction_message_retry_interval_seconds',
    ocppKey: 'TransactionMessageRetryInterval',
    label: 'TransactionMessageRetryInterval (seconds)',
    kind: 'int',
  },
];
