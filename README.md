# eveys-console

[![CI](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml/badge.svg)](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

System-administration console for the
[**eveys-mobility/OCPP**](https://github.com/eveys-mobility/OCPP)
gateway — the standalone Python service that terminates charger
WebSockets, validates and dispatches OCPP-J 1.6 / 2.0.1 messages,
and exposes a backend-facing contract over REST, gRPC, Kafka, and
webhooks. The Console is a **consumer of the gateway**; everything
this app shows (fleet status, transactions, MeterValues charts,
alerts, OCPP-config matrix) is rendered from the gateway's existing
surfaces.

Sign-in protected, single WebSocket per tab, live snapshot+tail
subscriptions backed by the gateway's Kafka topics and REST API.

Targets SRE / on-call engineers running the gateway — not end-customer
fleet managers. Apache-2.0.

---

## Quickstart

Brings up the Console server + web. Requires the OCPP gateway already
running on `:8080` with REST + Kafka — see the
[gateway quickstart](https://github.com/eveys-mobility/OCPP#quickstart).

```bash
# Prereqs: Node 20+, pnpm 9.15 (`corepack prepare pnpm@9.15.0 --activate`),
#          Docker.

git clone git@github.com:eveys-mobility/Console.git eveys-console
cd eveys-console

pnpm install
pnpm gen:api-types
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example    apps/web/.env
# Edit apps/server/.env: set JWT_SECRET, GATEWAY_TOKEN, KAFKA_BROKERS,
# CONSOLE_USERNAME / CONSOLE_PASSWORD.

pnpm dev
```

| URL | What |
|---|---|
| http://localhost:5180 | Web app (sign in with the credentials above) |
| http://localhost:8090 | Server REST + WS |
| http://localhost:8090/healthz | Liveness probe |
| http://localhost:8090/metrics | Prometheus scrape |

### Docker

```bash
docker compose -f deploy/docker-compose.yml up -d --build server web
```

Server on `:8090`, web on `:5180`. The `--profile observability` flag
also brings up the bundled Prometheus + Alertmanager pair (`:9091` and
`:9093`).

## Update (rebuild + restart)

One-shot updater pulls the latest, rebuilds both images, and recreates
the containers in place. No database — Console has no schema of its
own. Scope: this script updates the **Console only**. The OCPP
gateway has its own updater in the [gateway repo](https://github.com/eveys-mobility/OCPP)
(`make update` there).

```bash
sh scripts/updater.sh                     # both
sh scripts/updater.sh --server-only       # server only
sh scripts/updater.sh --web-only          # web only
sh scripts/updater.sh --no-pull           # skip git pull
```

On hosts with `EVEYS_ENV=production` the script prompts before
recreating; pass `FORCE_PROD=1` to silence.

## Pages

| Path | What |
|---|---|
| `/` | Operator dashboard — alerts summary, metrics, service status |
| `/inspect/charge-points` | Fleet view; AC/DC + power chips; faults filter |
| `/inspect/charge-points/$cpId` | Charger detail — connectors, sessions, diagnostics, device events |
| `/inspect/transactions` | Active + recent transactions across the fleet |
| `/inspect/transactions/$txId` | Per-transaction detail with live kW + kWh charts |
| `/sys/alerts` | Firing alerts, silences, channels, rules (Alertmanager + Prometheus) |
| `/sys/authorizations` | Operator-driven charger allowlist (#0013) |
| `/sys/ocpp-config` | Post-boot ChangeConfiguration matrix (type-agnostic keys) |
| `/sys/config` | Console + Gateway runtime overrides |
| `/sys/ocpp-conformance` | OCPP conformance matrix |

### OCPP config page (`/sys/ocpp-config`)

The gateway pushes a tunable set of **type-agnostic** OCPP keys after
every Accepted `BootNotification`: `MeterValueSampleInterval`,
`HeartbeatInterval`, `ConnectionTimeOut`, `WebSocketPingInterval`,
`TransactionMessageAttempts`, `TransactionMessageRetryInterval`.
Edits apply on the next boot of each charger; no gateway restart.

Measurand-list keys (`MeterValuesSampledData`, `StopTxnAlignedData`,
…) are intentionally **NOT** pushed here — they differ between AC
and DC chargers and `BootNotification` doesn't carry a reliable
AC/DC signal. Send those per-charger via the gateway's existing
`POST /api/v1/charge-points/{cp_id}/commands/change-configuration`.

## Surfaces (server)

| Surface | Bind | Purpose |
|---|---|---|
| WebSocket | `:8090/ws` | Subscriptions + RPCs in one connection (subprotocol `eveys-console-v1` + `bearer.<jwt>`) |
| REST (auth) | `:8090/auth/{challenge,login}` | PoW CAPTCHA + login → short-lived JWT |
| REST (sys) | `:8090/sys/*` | Status, config, alerts, transactions, authorizations, ocpp-config, diagnostics |
| Metrics | `:8090/metrics` | Prometheus scrape (network-ACL'd in prod) |
| Health | `:8090/healthz`, `:8090/readyz` | k8s probes |

## Configuration

Two `.env` files in `apps/`:

- **`apps/server/.env.example`** — server quickstart template (JWT,
  gateway token, Kafka brokers, Alertmanager / Prometheus URLs,
  Console login).
- **`apps/web/.env.example`** — web-side overrides for when the
  Console server is on a different host (defaults come from
  `window.location`).

The Configuration page (`/sys/config`) reads from the live process and
edits flow through one of two override stores:

- **Console keys** → `data/console-overrides.json` (persisted).
- **Gateway keys** → gateway's per-pod in-memory override map
  (cleared on gateway restart). Proxied via `/sys/gateway-admin-config`.

## Repo layout

```
apps/
├── server/                 Node + Fastify + ws + kafkajs Console server
│   └── src/{auth,broker,kafka,metrics,rest,routes,store}
└── web/                    React + shadcn/ui + TanStack Router
    └── src/{api,components,hooks,lib,pages}

packages/
├── protocol/               shared WS envelope contract (zod + TS types)
└── api-types/              types generated from the gateway's OpenAPI

deploy/
├── docker-compose.yml      server + web + (--profile observability)
└── observability/          bundled prometheus / alertmanager / alerts seed

scripts/
└── updater.sh              one-shot rebuild + recreate (Console only)
```

## Realtime model

One WebSocket per tab. Inside it: subscribe to a named query
(`charge-points`, `charge-point`, `transactions-active`,
`meter-history`, `status-history`, `device-events`) → snapshot + tail.
RPC to issue commands (`remote-start`, `remote-stop`, `reset`); the
server forwards to the gateway's REST and relays the response.

Wire format in `packages/protocol/` (zod schemas, enforced on both
ends). Kafka payloads decode through the vendored
`apps/server/proto/events/v1/` envelopes.

Per-transaction detail (`/inspect/transactions/$txId`) is REST-polled
every 5 s **and** force-refetches the instant a `cp.meter` event
arrives over WS, so the charts feel live without the broker carrying
per-tab per-tx state.

## Build, test, ship

```bash
pnpm format        # prettier
pnpm typecheck     # tsc --noEmit across all packages
pnpm test          # vitest, all packages
pnpm build         # tsc + vite build, both apps
```

CI runs `format:check + typecheck + test + build` on every PR, plus a
`validate-observability` job that runs `promtool check config/rules`
and `amtool check-config` against the bundled `deploy/observability/`
files.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
