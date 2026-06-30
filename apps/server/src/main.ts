// Process entry point. Wires everything together; only this file knows the
// concrete topology. Keep it thin — every component is unit-testable in
// isolation by passing fakes for the constructor deps.

// Load apps/server/.env if present, before reading any env vars. Done
// in-process (rather than requiring `node --env-file=.env`) so `pnpm dev`,
// `pnpm start`, and tools like `tsx` all work without extra flags.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(() => {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySensible from '@fastify/sensible';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';

import { PowVerifier } from './auth/pow.js';
import { UserStore } from './auth/users.js';
import { Broker } from './broker/broker.js';
import { configureEventLogReader } from './broker/queries.js';
import { loadConfig, type Config } from './config.js';
import { EventLogWriter } from './event-log/writer.js';
import { pruneEventLog } from './event-log/retention.js';
import { KafkaTail } from './kafka/tail.js';
import { buildLogger } from './logger.js';
import { GatewayClient } from './rest/gateway-client.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDiagnosticsRoutes } from './routes/diagnostics.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerSysAlertsRoute } from './routes/sys-alerts.js';
import { registerSysChargePointTransactionsRoute } from './routes/sys-charge-point-transactions.js';
import { registerSysChargePointTypeRoute } from './routes/sys-charge-point-type.js';
import { registerSysCpFramesRoute } from './routes/sys-cp-frames.js';
import { registerSysCpUptimeRoute } from './routes/sys-cp-uptime.js';
import { registerSysFleetStatusHistoryRoute } from './routes/sys-fleet-status-history.js';
import { registerSysCpEventsRoute } from './routes/sys-cp-events.js';
import { registerSysAuthorizationsRoute } from './routes/sys-authorizations.js';
import { registerSysCpReservationsRoute } from './routes/sys-cp-reservations.js';
import { registerSysConfigRoute } from './routes/sys-config.js';
import { registerSysConsoleAdminConfigRoute } from './routes/sys-console-admin-config.js';
import { registerSysGatewayAdminConfigRoute } from './routes/sys-gateway-admin-config.js';
import { registerSysGatewayConfigRoute } from './routes/sys-gateway-config.js';
import { registerSysKpisRoute } from './routes/sys-kpis.js';
import { registerSysRestartRoute } from './routes/sys-restart.js';
import { OverrideStore } from './store/override-store.js';
import { registerSysStatusRoute } from './routes/sys-status.js';
import { registerSysTransactionsRoute } from './routes/sys-transactions.js';
import { registerWsRoute } from './routes/ws.js';
import { ChannelsStore } from './store/channels-store.js';
import { TemplatesStore } from './store/templates-store.js';
import { DiagnosticsStore } from './store/diagnostics-store.js';
import { RulesStore } from './store/rules-store.js';

declare module 'fastify' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface FastifyInstance {
    config: Config;
  }
}

async function main() {
  const config = loadConfig();
  const logger = buildLogger(config);

  const app = Fastify({ loggerInstance: logger, disableRequestLogging: false });
  app.decorate('config', config);

  await app.register(fastifySensible);
  await app.register(fastifyRateLimit, {
    global: false, // Per-route only.
  });
  const allowedOrigins = config.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(fastifyCors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: false,
  });
  await app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    verify: { allowedAud: config.JWT_AUDIENCE },
  });
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 1024 * 64,
      handleProtocols: (protocols) => {
        // Accept the connection if both our subprotocol marker and a bearer
        // token subprotocol are present. The token is validated in the route.
        const arr = Array.from(protocols);
        if (!arr.includes('eveys-console-v1')) return false;
        return 'eveys-console-v1';
      },
    },
  });

  const gateway = new GatewayClient(config, logger);
  const kafka = new KafkaTail(config, logger);
  const broker = new Broker(kafka, gateway, logger);
  const users = new UserStore(config);
  const pow = new PowVerifier(config);
  const diagnosticsStore = new DiagnosticsStore(config.DIAGNOSTICS_DATA_DIR);
  const channelsStore = new ChannelsStore(config.ALERTMANAGER_CONFIG_PATH, {
    templatesInContainerPath: config.ALERTMANAGER_TEMPLATES_IN_CONTAINER_PATH,
  });
  const templatesStore = new TemplatesStore(config.ALERTMANAGER_TEMPLATES_PATH);
  const rulesStore = new RulesStore(config.ALERTS_RULES_CONFIG_PATH, config.PROMTOOL_PATH);
  const overrideStore = new OverrideStore(`${config.DIAGNOSTICS_DATA_DIR}/console-overrides.json`);
  await overrideStore.load();
  // Seed the managed Alertmanager + rules configs on first boot so
  // the observability containers have files to start against. Each
  // seed is empty + the synthetic shell needed to be valid; the
  // operator adds real entries through the UI.
  try {
    await channelsStore.seedIfMissing();
    logger.info({ path: config.ALERTMANAGER_CONFIG_PATH }, 'alertmanager.config.seeded');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alertmanager.config.seed-failed',
    );
  }
  try {
    await rulesStore.seedIfMissing();
    logger.info({ path: config.ALERTS_RULES_CONFIG_PATH }, 'alertmanager.rules.seeded');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alertmanager.rules.seed-failed',
    );
  }
  // Seed the named Alertmanager templates. The managed config's
  // `templates:` block points at the in-container path the compose
  // mount maps this to; without the file present, Alertmanager would
  // refuse to load on reload. Idempotent — operator edits survive.
  try {
    const created = await templatesStore.seedIfMissing();
    logger.info(
      { path: config.ALERTMANAGER_TEMPLATES_PATH, created },
      'alertmanager.templates.seeded',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alertmanager.templates.seed-failed',
    );
  }

  const startedAt = new Date();
  // All HTTP routes live under /api so a reverse proxy can route by
  // path prefix. WS stays at /ws — the browser builds its URL with the
  // CONSOLE_WS_URL helper, not the REST base, so it's intentionally
  // separate. Health/metrics are inside the prefix too: scrapers and
  // healthchecks already need to know the deployment's URL shape.
  await app.register(
    async (api) => {
      await registerHealthRoutes(api);
      await registerMetricsRoute(api);
      await registerAuthRoutes(api, { pow, users });
      await registerSysStatusRoute(api, { broker, gateway, kafka, startedAt });
      await registerSysConfigRoute(api, { config, overrideStore });
      await registerSysConsoleAdminConfigRoute(api, { config, overrideStore, logger });
      await registerSysGatewayConfigRoute(api, { gateway });
      await registerSysGatewayAdminConfigRoute(api, { gateway });
      await registerSysAuthorizationsRoute(api, { gateway });
      await registerSysRestartRoute(api, { config, gateway });
      await registerSysKpisRoute(api, { gateway });
      await registerSysChargePointTransactionsRoute(api, { gateway });
      await registerSysChargePointTypeRoute(api, { gateway });
      await registerSysCpReservationsRoute(api, { gateway });
      await registerSysCpFramesRoute(api, { gateway });
      await registerSysCpUptimeRoute(api, { gateway });
      await registerSysFleetStatusHistoryRoute(api, { gateway });
      await registerSysCpEventsRoute(api, { eventLogRoot: config.EVENT_LOG_DIR });
      await registerSysTransactionsRoute(api, { gateway });
      await registerSysAlertsRoute(api, { logger, channelsStore, rulesStore });
      await registerDiagnosticsRoutes(api, { store: diagnosticsStore });
    },
    { prefix: '/api' },
  );
  await registerWsRoute(app, { broker, gateway });

  if (users.size === 0) {
    logger.warn('login disabled: CONSOLE_USERS is empty. WS still accepts pre-minted JWTs.');
  } else {
    logger.info({ users: users.size }, 'login enabled');
  }

  // Device-event durable log. The writer subscribes to the same
  // Kafka tail the broker uses; the resolver bootstraps from
  // tailLastN so the detail panel renders history immediately on
  // page open. Daily retention prune keeps disk bounded.
  const eventLog = new EventLogWriter({
    root: config.EVENT_LOG_DIR,
    fsyncIntervalMs: config.EVENT_LOG_FSYNC_INTERVAL_MS,
    logger,
  });
  eventLog.attach(kafka);
  configureEventLogReader({
    root: config.EVENT_LOG_DIR,
    bootstrapLimit: config.EVENT_LOG_BOOTSTRAP_LIMIT,
  });
  const eventLogPruneTimer = setInterval(
    () => {
      void pruneEventLog({
        root: config.EVENT_LOG_DIR,
        retentionMonths: config.EVENT_LOG_RETENTION_MONTHS,
        logger,
      })
        .then((r) => {
          if (r.removed.length > 0) {
            logger.info(
              { removed: r.removed.length, errors: r.errors.length },
              'event-log.retention.swept',
            );
          }
        })
        .catch((err: unknown) => logger.error({ err }, 'event-log.retention.failed'));
    },
    24 * 60 * 60 * 1000,
  );
  eventLogPruneTimer.unref?.();

  await kafka.start();
  broker.start();

  const stop = async (signal: string) => {
    logger.info({ signal }, 'shutdown.begin');
    try {
      clearInterval(eventLogPruneTimer);
      await eventLog.close();
      broker.stop();
      await kafka.stop();
      await app.close();
      diagnosticsStore.close();
      logger.info('shutdown.done');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown.failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info({ host: config.HOST, port: config.PORT }, 'listening');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
