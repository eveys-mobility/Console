import { z } from 'zod';

export const configSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: z.coerce.boolean().default(false),

  // JWT — for v1 we accept HS256 with a shared secret. Plug an IDP later by
  // switching to RS256 + JWKS; the verify call lives in src/auth/jwt.ts.
  JWT_SECRET: z.string().min(16),
  JWT_AUDIENCE: z.string().default('eveys-console'),
  JWT_ISSUER: z.string().default('eveys-console'),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3600),

  // Login users. CSV of `username:bcrypthash` pairs. Empty disables login
  // entirely (the WS still accepts pre-minted JWTs — useful for headless
  // tests / service callers).
  // Generate a hash with `pnpm --filter @eveys-console/server hash-password`.
  CONSOLE_USERS: z.string().default(''),

  // Convenience plaintext login for laptop dev. When both are set, the
  // server hashes the password at boot and registers the user. Overrides
  // any matching entry in CONSOLE_USERS. Leave empty in production —
  // prefer CONSOLE_USERS with pre-computed bcrypt hashes.
  CONSOLE_USERNAME: z.string().default(''),
  CONSOLE_PASSWORD: z.string().default(''),

  // Anti-robot proof-of-work CAPTCHA on the login form.
  // Difficulty = number of leading zero bits the client's hash must have.
  // 16 ≈ 50 ms on a laptop; 20 ≈ 1 s; tune for your threat model.
  AUTH_POW_DIFFICULTY: z.coerce.number().int().min(0).max(28).default(16),
  AUTH_POW_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  // Login rate limit per IP. The WS endpoint has its own limits.
  AUTH_LOGIN_MAX_PER_MIN: z.coerce.number().int().positive().default(5),

  // Comma-separated list of allowed Origin headers on the WS handshake and
  // login routes. Empty = no Origin check (laptop dev). Set to your console
  // hostname(s) in production.
  ALLOWED_ORIGINS: z.string().default(''),

  // Gateway upstream
  GATEWAY_BASE_URL: z.string().url(),
  GATEWAY_TOKEN: z.string().min(1),

  // Alertmanager (observability profile). Optional: when unset, the
  // /sys/alerts/firing proxy returns `{ alerts: [], unavailable: true }`
  // so the Console UI renders the "not configured" hint instead of an
  // error toast.
  ALERTMANAGER_URL: z.string().url().optional(),

  // Path to the Alertmanager config file the Console manages. Compose
  // mounts this file into the Alertmanager container as its
  // --config.file; the Console reads + writes it through the Channels
  // tab on /sys/alerts. Defaults to `./data/alertmanager-managed.yml`
  // alongside the SQLite + diagnostics uploads.
  ALERTMANAGER_CONFIG_PATH: z.string().default('./data/alertmanager-managed.yml'),

  // Console-managed Alertmanager templates file. Holds the named Go
  // templates (`eveys.email.html`, `eveys.telegram.message`, …) the
  // managed receivers reference for their `html` / `message` / `title`
  // / `text` fields. Lives alongside ALERTMANAGER_CONFIG_PATH; the
  // compose mount maps both into the Alertmanager container. The
  // managed config's `templates:` block points at the in-container
  // path (configured via ALERTMANAGER_TEMPLATES_IN_CONTAINER_PATH).
  ALERTMANAGER_TEMPLATES_PATH: z.string().default('./data/alertmanager-templates.yml'),

  // Path **as Alertmanager sees it inside its container** for the
  // templates file. The Console writes ALERTMANAGER_TEMPLATES_PATH on
  // the host and the compose bind mounts that to this in-container
  // path. The managed config's `templates:` block must reference the
  // in-container path, not the host one. Keep this aligned with
  // deploy/docker-compose.yml's volume mount.
  ALERTMANAGER_TEMPLATES_IN_CONTAINER_PATH: z
    .string()
    .default('/etc/alertmanager/alertmanager-templates.yml'),

  // Base URL of Prometheus for the Rules tab on /sys/alerts. Optional —
  // when unset, /sys/alerts/rules returns the unavailable envelope and
  // the Rules tab renders its "Prometheus not configured" hint.
  PROMETHEUS_URL: z.string().url().optional(),

  // Path to the Prometheus rules file the Console manages via the
  // Rules tab on /sys/alerts. Compose's Prometheus container mounts
  // this file as its --rule_files target; the Console reads + writes
  // it through the managed-rules routes. The Console-managed group is
  // `console-managed`; rules outside that group (bundled / hand-edited)
  // are preserved on round-trip but not editable through the UI.
  ALERTS_RULES_CONFIG_PATH: z.string().default('./data/alerts-managed.yml'),

  // Path to `promtool` for rule validation. When `promtool check rules`
  // is available the Console runs it before writing the managed file
  // so a malformed expression can't break Prometheus on reload. When
  // unset / not found on PATH, validation is skipped with a warning
  // log and the API surfaces an `validation_skipped: true` flag.
  PROMTOOL_PATH: z.string().default('promtool'),

  // Kafka tail
  KAFKA_BROKERS: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1)),
  KAFKA_CLIENT_ID: z.string().default('eveys-console'),
  KAFKA_GROUP_ID: z.string().default('eveys-console'),
  KAFKA_TOPICS_BOOT: z.string().default('cp.boot'),
  KAFKA_TOPICS_STATUS: z.string().default('cp.status'),
  KAFKA_TOPICS_METER: z.string().default('cp.meter'),
  KAFKA_TOPICS_TX_STARTED: z.string().default('tx.started'),
  // tx.stopped fires on StopTransaction. Without it the Transactions
  // card on the detail page doesn't drop a row back to "completed"
  // until the next 5s poll — and the Statistics card's completed
  // count lags by the same window.
  KAFKA_TOPICS_TX_STOPPED: z.string().default('tx.stopped'),
  // Presence: `cp.connected` fires when a charger opens a WS to the
  // gateway, `cp.disconnected` when it goes away. The Console needs
  // both for the `online` flag on the list view to flip in real time
  // — without them, online/offline only updates when a status / boot
  // event happens to come through, which is rarely.
  KAFKA_TOPICS_CONNECTED: z.string().default('cp.connected'),
  KAFKA_TOPICS_DISCONNECTED: z.string().default('cp.disconnected'),
  // DiagnosticsStatusNotification + FirmwareStatusNotification flips
  // (Idle → Uploading → Uploaded, etc.). The gateway records the
  // latest value on the charger row; without these subscriptions the
  // detail page's chips don't update until the operator manually
  // reloads. Names match gateway-side `kafka_topic_cp_diagnostics_status`
  // / `_firmware_status`.
  KAFKA_TOPICS_DIAGNOSTICS_STATUS: z.string().default('cp.diagnostics_status'),
  KAFKA_TOPICS_FIRMWARE_STATUS: z.string().default('cp.firmware_status'),

  // WS hardening
  WS_MAX_SUBSCRIPTIONS_PER_CONN: z.coerce.number().int().positive().default(50),
  WS_PING_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // Diagnostics upload receiver. The Console mints a per-command upload
  // URL the operator hands to the charger via GetDiagnostics / GetLog;
  // the charger PUTs the resulting log file back here. v1 is single-pod,
  // dev-only reachability — production ingress is a follow-up.
  DIAGNOSTICS_DATA_DIR: z.string().default('./data'),
  DIAGNOSTICS_UPLOAD_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  DIAGNOSTICS_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  /** Optional. When unset, the server fabricates `http://${HOST}:${PORT}`
   *  at runtime — fine for laptop dev. Set this to the externally-reachable
   *  base URL when running behind a reverse proxy. */
  CONSOLE_PUBLIC_BASE_URL: z.string().optional(),

  // Device-event log. Appends one NDJSON line per DeviceEvent into
  // `<root>/<cp_id>/<YYYY-MM>.ndjson`. Read paths: tail-last-N for the
  // detail-page bootstrap, range+substring search for the panel's
  // search box. Old files are pruned by month.
  EVENT_LOG_DIR: z.string().default('./data/event-log'),
  EVENT_LOG_RETENTION_MONTHS: z.coerce.number().int().positive().default(12),
  EVENT_LOG_FSYNC_INTERVAL_MS: z.coerce.number().int().nonnegative().default(200),
  EVENT_LOG_BOOTSTRAP_LIMIT: z.coerce.number().int().positive().default(200),

  // Admin / restart. POST /sys/restart and POST /sys/restart-gateway
  // are dormant unless these toggles flip them on. Off by default —
  // a prod operator opts in only when the UI's pending-restart banner
  // is actually wanted. Debounce mirrors the gateway-side guard so a
  // double-click can't queue two exits.
  CONSOLE_RESTART_ENABLED: z.coerce.boolean().default(false),
  CONSOLE_RESTART_DEBOUNCE_MS: z.coerce.number().int().positive().default(5000),
});

export type Config = z.infer<typeof configSchema>;

const PLACEHOLDER_SECRETS = new Set([
  'replace-me-with-a-real-secret-of-at-least-16-bytes',
  'changeme',
  'secret',
  'dev-secret',
]);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  // Refuse to bind a non-loopback interface with a placeholder JWT_SECRET.
  // This is the difference between "vulnerable laptop dev" and "fully open
  // admin endpoint on the public internet". A misconfigured deploy is the
  // dominant failure mode; this trips it before it does damage.
  if (PLACEHOLDER_SECRETS.has(cfg.JWT_SECRET) && !LOOPBACK_HOSTS.has(cfg.HOST)) {
    throw new Error(
      `Refusing to start: JWT_SECRET is a placeholder and HOST=${cfg.HOST} is not loopback.\n` +
        `Set JWT_SECRET to a strong value (e.g. \`openssl rand -base64 48\`) before binding a public interface.`,
    );
  }

  return cfg;
}
