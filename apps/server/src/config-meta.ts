// Per-key metadata for the configuration surface exposed at GET /sys/config.
//
// Co-located with the schema in config.ts so that adding a new key forces a
// matching metadata row at typecheck time (the `keys` array is typed against
// `keyof Config`).
//
// The console reads this to render the Configuration page: description,
// default, accepted range, mutability, restart impact, and whether the
// current value is sensitive (and should be masked in the UI).

import type { Config } from './config.js';
import { isOverridable, type OverrideStore } from './store/override-store.js';

/** Whether changing this key in the deployment requires a process bounce. */
export type RestartImpact =
  | 'none' // value is read every request; change takes effect immediately
  | 'console' // Console process must restart to pick up
  | 'gateway' // change is on the gateway side; restart the gateway
  | 'both';

/** How a key got its current value. */
export type ValueSource =
  | 'env' // came from process.env at boot
  | 'default' // schema default; env var was unset or empty
  | 'computed' // derived from other inputs
  | 'override'; // operator-set runtime override (data/console-overrides.json)

export interface KeyMeta {
  description: string;
  /** Grouping label for the config page (mirrors the gateway's
   * json_schema_extra.category). Lowercase snake_case. */
  category: string;
  /** Can an operator change this in deployment? `false` = build-time / fixed. */
  mutable: boolean;
  /** What needs to restart for a change to take effect. */
  restart: RestartImpact;
  /** Free-form description of accepted values. */
  range: string;
  /** Stringified default value (or `''` when there is no default). */
  default: string;
  /** Mask the value when rendering. */
  sensitive: boolean;
}

const META: Record<keyof Config, KeyMeta> = {
  HOST: {
    description: 'Network interface the Console server binds to.',
    category: 'network',
    mutable: true,
    restart: 'console',
    range: 'IPv4/IPv6 address; "0.0.0.0" for all interfaces, "127.0.0.1" for loopback only.',
    default: '0.0.0.0',
    sensitive: false,
  },
  PORT: {
    description: 'TCP port the Console server listens on.',
    category: 'network',
    mutable: true,
    restart: 'console',
    range: '1–65535',
    default: '8090',
    sensitive: false,
  },
  LOG_LEVEL: {
    description: 'Minimum severity emitted by the structured logger.',
    category: 'logging',
    mutable: true,
    restart: 'console',
    range: 'fatal | error | warn | info | debug | trace',
    default: 'info',
    sensitive: false,
  },
  LOG_PRETTY: {
    description: 'Engage pino-pretty for human-readable logs (dev only).',
    category: 'logging',
    mutable: true,
    restart: 'console',
    range: 'true | false',
    default: 'false',
    sensitive: false,
  },

  JWT_SECRET: {
    description:
      'HS256 signing secret for browser JWTs. Refuses to bind a non-loopback HOST when set to a known placeholder.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: '≥ 16 characters. Recommend `openssl rand -base64 48`.',
    default: '',
    sensitive: true,
  },
  JWT_AUDIENCE: {
    description: 'Audience claim minted into login JWTs and required at verify time.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'free-form string',
    default: 'eveys-console',
    sensitive: false,
  },
  JWT_ISSUER: {
    description: 'Issuer claim minted into login JWTs and required at verify time.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'free-form string',
    default: 'eveys-console',
    sensitive: false,
  },
  JWT_TTL_SECONDS: {
    description: 'Lifetime of issued JWTs.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'positive integer (seconds)',
    default: '28800',
    sensitive: false,
  },

  CONSOLE_USERS: {
    description:
      'Comma-separated `username:bcrypthash` pairs. Empty disables the login form (pre-minted JWTs still accepted).',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range:
      'CSV of `user:$2a$…` entries; generate hashes with `pnpm --filter @eveys-console/server hash-password`.',
    default: '',
    sensitive: true,
  },

  CONSOLE_USERNAME: {
    description:
      'Plaintext convenience login (paired with CONSOLE_PASSWORD). Hashed at boot. Overrides any matching CONSOLE_USERS entry.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'non-empty username, or empty to disable',
    default: '',
    sensitive: false,
  },
  CONSOLE_PASSWORD: {
    description:
      'Plaintext password for CONSOLE_USERNAME. Hashed at boot with bcrypt cost 10. Leave empty in production; prefer CONSOLE_USERS.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'non-empty password, or empty to disable',
    default: '',
    sensitive: true,
  },

  AUTH_POW_DIFFICULTY: {
    description:
      'Proof-of-work CAPTCHA difficulty (leading-zero bits required on the client hash). 16 ≈ 50 ms; 20 ≈ 1 s.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: '0–28',
    default: '16',
    sensitive: false,
  },
  AUTH_POW_TTL_SECONDS: {
    description: 'How long a minted PoW challenge stays valid before the client must re-fetch.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'positive integer (seconds)',
    default: '120',
    sensitive: false,
  },
  AUTH_LOGIN_MAX_PER_MIN: {
    description: 'Per-IP rate limit on POST /auth/login.',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range: 'positive integer (requests per minute)',
    default: '5',
    sensitive: false,
  },

  ALLOWED_ORIGINS: {
    description:
      'CSV of Origin headers permitted on the WS handshake and login routes. Empty disables Origin checking (local dev only).',
    category: 'auth',
    mutable: true,
    restart: 'console',
    range:
      'CSV of fully-qualified origins (e.g. `https://console.example.com,https://console.eu.example.com`)',
    default: '',
    sensitive: false,
  },

  GATEWAY_BASE_URL: {
    description:
      'Base URL of the OCPP gateway REST API. Console uses this for snapshots and to forward RPCs.',
    category: 'gateway',
    mutable: true,
    restart: 'console',
    range: 'http(s)://host:port URL.',
    default: '',
    sensitive: false,
  },
  GATEWAY_TOKEN: {
    description: 'Bearer token sent to the gateway on every REST call.',
    category: 'gateway',
    mutable: true,
    restart: 'console',
    range: 'opaque token issued by the gateway',
    default: '',
    sensitive: true,
  },

  ALERTMANAGER_URL: {
    description:
      'Base URL of Alertmanager for the firing-alerts panel. Optional — when unset, the panel renders "Alertmanager not configured" instead of an error.',
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'http(s)://host:port URL (no trailing slash).',
    default: '',
    sensitive: false,
  },

  ALERTMANAGER_CONFIG_PATH: {
    description:
      'Path to the Alertmanager config file the Console manages via the /sys/alerts Channels tab. Compose mounts this file into the Alertmanager container.',
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'filesystem path readable + writable by the Console.',
    default: './data/alertmanager-managed.yml',
    sensitive: false,
  },

  ALERTMANAGER_TEMPLATES_PATH: {
    description:
      'Host-side path to the Console-managed Alertmanager templates file. Holds the named Go templates Channels reference for their html/message/title/text fields. Compose mounts this file into the Alertmanager container.',
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'filesystem path readable + writable by the Console.',
    default: './data/alertmanager-templates.yml',
    sensitive: false,
  },

  ALERTMANAGER_TEMPLATES_IN_CONTAINER_PATH: {
    description:
      "Path **as Alertmanager sees it inside its container** for the templates file. Must match the destination of the bind mount in deploy/docker-compose.yml. The managed config's `templates:` block references this path so Alertmanager can load it.",
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'absolute path inside the Alertmanager container.',
    default: '/etc/alertmanager/alertmanager-templates.yml',
    sensitive: false,
  },

  PROMETHEUS_URL: {
    description:
      'Base URL of Prometheus for the Rules tab on /sys/alerts. Optional — when unset, the Rules tab renders "Prometheus not configured".',
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'http(s)://host:port URL (no trailing slash).',
    default: '',
    sensitive: false,
  },

  ALERTS_RULES_CONFIG_PATH: {
    description:
      'Path to the Prometheus rules file the Console manages via the /sys/alerts Rules tab. Compose mounts this file into the Prometheus container.',
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'filesystem path readable + writable by the Console.',
    default: './data/alerts-managed.yml',
    sensitive: false,
  },

  PROMTOOL_PATH: {
    description:
      "Path to `promtool` for rule validation. The Console runs `promtool check rules` before writing the managed file so a malformed expression can't break Prometheus on reload. Falls back to PATH lookup.",
    category: 'observability',
    mutable: true,
    restart: 'console',
    range: 'filesystem path or PATH-resolvable command name.',
    default: 'promtool',
    sensitive: false,
  },

  KAFKA_BROKERS: {
    description: 'CSV of Kafka bootstrap brokers the Console tails for live events.',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'CSV of host:port (e.g. `kafka-0:9092,kafka-1:9092,kafka-2:9092`)',
    default: '',
    sensitive: false,
  },
  KAFKA_CLIENT_ID: {
    description: 'kafkajs `clientId` reported to the brokers.',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'free-form string',
    default: 'eveys-console',
    sensitive: false,
  },
  KAFKA_GROUP_ID: {
    description:
      'Kafka consumer-group id. All Console pods share one group today; a per-pod model is on the multi-pod track.',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'free-form string',
    default: 'eveys-console',
    sensitive: false,
  },
  KAFKA_TOPICS_BOOT: {
    description:
      'Topic the Console tails for BootNotification events. Must match the topic the gateway publishes to (gateway-side: kafka_topic_cp_boot).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.boot',
    sensitive: false,
  },
  KAFKA_TOPICS_STATUS: {
    description:
      'Topic the Console tails for StatusNotification events. Must match the topic the gateway publishes to (gateway-side: kafka_topic_cp_status).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.status',
    sensitive: false,
  },
  KAFKA_TOPICS_METER: {
    description:
      'Topic the Console tails for MeterValues samples. Must match the topic the gateway publishes to (gateway-side: kafka_topic_cp_meter).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.meter',
    sensitive: false,
  },
  KAFKA_TOPICS_TX_STARTED: {
    description:
      'Topic the Console tails for StartTransaction events. Must match the topic the gateway publishes to (gateway-side: kafka_topic_tx_started).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'tx.started',
    sensitive: false,
  },
  KAFKA_TOPICS_TX_STOPPED: {
    description:
      'Topic the Console tails for StopTransaction events. Drives the live "session completed" pivot on the per-charger Transactions card (gateway-side: kafka_topic_tx_stopped).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'tx.stopped',
    sensitive: false,
  },
  KAFKA_TOPICS_CONNECTED: {
    description:
      'Topic the Console tails for charger-online transitions. Drives the live `online` flag on the list view and the detail page header (gateway-side: kafka_topic_cp_connected).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.connected',
    sensitive: false,
  },
  KAFKA_TOPICS_DISCONNECTED: {
    description:
      'Topic the Console tails for charger-offline transitions. Companion to KAFKA_TOPICS_CONNECTED; without it the `online` flag only flips when a status/boot event happens to come through (gateway-side: kafka_topic_cp_disconnected).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.disconnected',
    sensitive: false,
  },
  KAFKA_TOPICS_DIAGNOSTICS_STATUS: {
    description:
      'Topic the Console tails for DiagnosticsStatusNotification events. Drives the live diagnostics-status chip on the detail page — without it the chip stays stuck on whatever value was in the initial snapshot (gateway-side: kafka_topic_cp_diagnostics_status).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.diagnostics_status',
    sensitive: false,
  },
  KAFKA_TOPICS_FIRMWARE_STATUS: {
    description:
      'Topic the Console tails for FirmwareStatusNotification events. Companion to KAFKA_TOPICS_DIAGNOSTICS_STATUS for UpdateFirmware / SignedUpdateFirmware flows (gateway-side: kafka_topic_cp_firmware_status).',
    category: 'kafka',
    mutable: true,
    restart: 'console',
    range: 'topic name',
    default: 'cp.firmware_status',
    sensitive: false,
  },

  WS_MAX_SUBSCRIPTIONS_PER_CONN: {
    description: 'Cap on simultaneous subscriptions per WebSocket. Plumbed but not yet enforced.',
    category: 'websocket',
    mutable: true,
    restart: 'console',
    range: 'positive integer',
    default: '50',
    sensitive: false,
  },
  WS_PING_INTERVAL_MS: {
    description: 'Server-side ping cadence on the WS connection. Detects half-open peers.',
    category: 'websocket',
    mutable: true,
    restart: 'console',
    range: 'positive integer (milliseconds)',
    default: '30000',
    sensitive: false,
  },
  WS_IDLE_TIMEOUT_MS: {
    description: 'Idle disconnect threshold on the WS connection.',
    category: 'websocket',
    mutable: true,
    restart: 'console',
    range: 'positive integer (milliseconds)',
    default: '120000',
    sensitive: false,
  },

  DIAGNOSTICS_DATA_DIR: {
    description:
      'Filesystem root for the diagnostics SQLite metadata DB and the per-charger uploads tree.',
    category: 'diagnostics',
    mutable: true,
    restart: 'console',
    range: 'absolute or repo-relative path',
    default: './data',
    sensitive: false,
  },
  DIAGNOSTICS_UPLOAD_TTL_SECONDS: {
    description:
      'Lifetime of a per-command upload token before it is auto-expired. Operators get this long after issuing the URL to actually receive the upload.',
    category: 'diagnostics',
    mutable: true,
    restart: 'console',
    range: 'positive integer (seconds)',
    default: '3600',
    sensitive: false,
  },
  DIAGNOSTICS_MAX_UPLOAD_BYTES: {
    description:
      'Per-upload size cap. The body limit is enforced on the upload route directly (not the global Fastify limit), so other routes are unaffected.',
    category: 'diagnostics',
    mutable: true,
    restart: 'console',
    range: 'positive integer (bytes)',
    default: '52428800',
    sensitive: false,
  },
  CONSOLE_PUBLIC_BASE_URL: {
    description:
      'Externally-reachable base URL of the Console (used to build upload URLs handed to chargers). Falls back to `http://HOST:PORT` for local dev.',
    category: 'diagnostics',
    mutable: true,
    restart: 'console',
    range: 'http(s)://host[:port], no trailing slash',
    default: '',
    sensitive: false,
  },
  EVENT_LOG_DIR: {
    description:
      'Filesystem root for the device-event log. One file per charger per month: `<root>/<cp_id>/<YYYY-MM>.ndjson`. Append-only.',
    category: 'event-log',
    mutable: true,
    restart: 'console',
    range: 'absolute or repo-relative path',
    default: './data/event-log',
    sensitive: false,
  },
  EVENT_LOG_RETENTION_MONTHS: {
    description:
      'How many months of device events to retain on disk. The nightly prune deletes whole month files older than this; reducing the value frees disk on the next sweep.',
    category: 'event-log',
    mutable: true,
    restart: 'console',
    range: 'positive integer (months)',
    default: '12',
    sensitive: false,
  },
  EVENT_LOG_FSYNC_INTERVAL_MS: {
    description:
      'Milliseconds between fsync calls for the event-log writer. Bounds the loss-on-crash window without paying a syscall per line. 0 disables coalescing.',
    category: 'event-log',
    mutable: true,
    restart: 'console',
    range: 'non-negative integer (milliseconds)',
    default: '200',
    sensitive: false,
  },
  EVENT_LOG_BOOTSTRAP_LIMIT: {
    description:
      'How many recent events the device-events resolver returns on snapshot. Sets the initial render size of the per-charger event panel.',
    category: 'event-log',
    mutable: true,
    restart: 'console',
    range: 'positive integer (rows)',
    default: '200',
    sensitive: false,
  },
  CONSOLE_RESTART_ENABLED: {
    description:
      'Enable POST /sys/restart and POST /sys/restart-gateway so the Console UI can drive a process restart (used for config keys that need a fresh boot). Off by default; flip on only when the UI overlay is wired and the operator wants it. Both endpoints return 503 SERVICE_UNAVAILABLE when this is false.',
    category: 'admin',
    mutable: false,
    restart: 'console',
    range: 'boolean',
    default: 'false',
    sensitive: false,
  },
  CONSOLE_RESTART_DEBOUNCE_MS: {
    description:
      'Minimum gap between accepted restart requests. A second POST inside this window returns 202 + already_scheduled but does NOT queue another exit. Guards against double-clicks and the UI overlay racing the operator button.',
    category: 'admin',
    mutable: false,
    restart: 'console',
    range: 'positive integer (milliseconds)',
    default: '5000',
    sensitive: false,
  },
};

export interface ConfigEntry {
  key: keyof Config;
  /** Stringified current value, or a mask when the key is sensitive. */
  value: string;
  /** When `sensitive` and the underlying value is non-empty, the real value is replaced by `value: '••••••••'`. */
  sensitive: boolean;
  default: string;
  source: ValueSource;
  description: string;
  category: string;
  mutable: boolean;
  restart: RestartImpact;
  range: string;
  /** True when the key is in the runtime-override allowlist. The UI
   *  uses this to decide whether to render the inline-edit affordances
   *  or the read-only display. */
  overridable: boolean;
}

const MASK = '••••••••';

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Build the rendered list. Sensitive values are masked unless the underlying
 * value is empty (in which case `<empty>` is more useful than rows of dots).
 *
 * When `overrideStore` is passed, the override for each key (if present) wins
 * over the env-loaded value and the row's `source` flips to `'override'`. The
 * UI uses that flag to render a "Reset to env" affordance.
 */
export function describeConfig(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  overrideStore?: OverrideStore,
): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  const overrides = overrideStore?.snapshot().overrides ?? {};
  for (const key of Object.keys(META) as (keyof Config)[]) {
    const meta = META[key];
    const overridable = isOverridable(String(key));
    const hasOverride = overridable && key in overrides;
    // Effective render: prefer the override string. We could parse +
    // re-stringify for type fidelity but the override is already the
    // canonical wire form (the route's POST stored exactly what the
    // operator typed).
    const rendered = hasOverride ? overrides[key]! : stringify(cfg[key]);
    const masked = meta.sensitive && rendered.length > 0 ? MASK : rendered;
    const source: ValueSource = hasOverride
      ? 'override'
      : env[key] !== undefined && env[key] !== ''
        ? 'env'
        : 'default';
    out.push({
      key,
      value: masked,
      sensitive: meta.sensitive,
      default: meta.default,
      source,
      description: meta.description,
      category: meta.category,
      mutable: meta.mutable,
      restart: meta.restart,
      range: meta.range,
      overridable,
    });
  }
  return out;
}

export const __forTest = { META, MASK };
