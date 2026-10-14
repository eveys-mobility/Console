import type { KafkaTail } from '../kafka/tail.js';
import type { GatewayClient } from '../rest/gateway-client.js';

interface HealthDeps {
  kafka: Pick<KafkaTail, 'isRunning' | 'subscribedTopics'>;
  gateway: Pick<GatewayClient, 'health'>;
}

// Use a loose `app` type so this helper composes with any FastifyInstance
// regardless of how the parent app's logger / type provider were narrowed.
// Strict typing happens at the route handler, not the registrar.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerHealthRoutes(app: any, deps: HealthDeps) {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req: unknown, reply: { code: (status: number) => unknown }) => {
    const running = deps.kafka.isRunning();
    const topics = deps.kafka.subscribedTopics();
    const kafka = { ok: running && topics.length > 0, consumer_running: running, topics };
    const gateway = await coreGatewayProbe(deps.gateway);
    const ok = kafka.ok && gateway.ok;
    reply.code(ok ? 200 : 503);
    // Scope is request availability, not archive completeness or ingestion progress.
    return { ok, scope: 'console_gateway_core', components: { kafka, gateway } };
  });
}

async function coreGatewayProbe(gateway: HealthDeps['gateway']) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = (await Promise.race([
      gateway.health(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('probe timeout'));
        }, 1000);
      }),
    ])) as { status?: string; components?: Record<string, string | null>; archive?: unknown };
    const components = body?.components;
    const coreOk = components?.postgres === 'ok' && components?.redis === 'ok';
    return {
      ok: coreOk && (body?.status === 'ok' || body?.status === 'degraded'),
      status: body?.status ?? 'unknown',
      ...(components ? { components } : {}),
      ...(body?.archive ? { archive: body.archive } : {}),
    };
  } catch {
    return { ok: false, status: 'unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
