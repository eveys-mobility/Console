// REST client for the "OCPP boot config" page.
//
// One surface: the gateway's runtime-overrides store, reached via the
// existing `/sys/gateway-admin-config` proxy. OCPP_FIELDS describes
// the type-agnostic keys the gateway pushes after every Accepted
// BootNotification. Measurand-list keys (MeterValuesSampledData,
// StopTxnAlignedData, …) are intentionally NOT included — they
// differ between AC and DC chargers and BootNotification doesn't
// carry a reliable AC/DC signal, so the gateway leaves them to the
// per-charger `ChangeConfiguration` command surface.

export type OcppFieldKind = 'int' | 'bool';

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
  /** For `kind: 'int'` fields with a small enum-like domain, a list of
   *  labelled options rendered as a select instead of a free-form
   *  numeric input. Ignored for other kinds. */
  intOptions?: ReadonlyArray<{ value: number; label: string }>;
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
  // ISO 15118 Plug-and-Charge trio. Vendor-common on DC chargers.
  // Kept together so operators reason about them as one PnC policy.
  {
    key: 'ocpp_cfg_iso15118_pnc_enabled',
    ocppKey: 'ISO15118PnCEnabled',
    label: 'ISO15118PnCEnabled',
    kind: 'bool',
    hint: 'Master switch for ISO 15118 Plug-and-Charge. Off by default: only enable when the backend has a contract-cert validation path.',
  },
  {
    key: 'ocpp_cfg_plug_and_charge_mode',
    ocppKey: 'PlugandChargeMode',
    label: 'PlugandChargeMode',
    kind: 'int',
    intOptions: [
      { value: 0, label: '0 — EIM only (no PnC)' },
      { value: 1, label: '1 — EIM preferred, PnC fallback' },
      { value: 2, label: '2 — PnC preferred' },
    ],
    hint: 'How a PnC-capable charger picks between external ID (RFID/app) and PnC.',
  },
  {
    key: 'ocpp_cfg_contract_validation_offline',
    ocppKey: 'ContractValidationOffline',
    label: 'ContractValidationOffline',
    kind: 'bool',
    hint: 'Trust a locally-cached ISO 15118 contract cert when the CSMS is unreachable.',
  },
];
