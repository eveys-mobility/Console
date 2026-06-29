# Console

[![CI](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml/badge.svg)](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

System-administration console for the OCPP gateway. Sign-in protected,
single WebSocket per tab, live snapshot+tail subscriptions backed by
the gateway's existing Kafka topics and REST API.

The console targets SRE / on-call engineers operating the gateway —
not end-customer fleet managers. The front page (`/`) is an operator
dashboard: alerts summary, headline metrics (chargers online, active
sessions, faults), service status. Charge-point and transaction
inspection live under `/inspect`; alerts management lives under
`/sys/alerts`; configuration under `/sys/config`.

The gateway is consumed unchanged; everything the console offers is
built on the gateway's existing surfaces.

Apache-2.0.

## Surfaces

| Surface        | Bind                                | Direction         | Purpose                                                                                   |
| -------------- | ----------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| WebSocket      | `:8090/ws`                          | browser → Console | Subscriptions + RPCs in one connection. Subprotocol: `eveys-console-v1` + `bearer.<jwt>`. |
| REST (auth)    | `:8090/auth/{challenge,login}`      | browser → Console | Proof-of-work CAPTCHA + username/password login. Returns a short-lived JWT.               |
| REST (status)  | `:8090/sys/status`                  | browser → Console | Aggregated service health (gateway probe + Kafka + WS connection count). JWT-protected.   |
| REST (alerts)  | `:8090/sys/alerts/*`                | browser → Console | Firing alerts + silences + channels + rules. Proxies Alertmanager/Prometheus. JWT-gated.  |
| REST (config)  | `:8090/sys/{config,gateway-config}` | browser → Console | Read-only config introspection; Console + Gateway tabs.                                   |
| REST (admin)   | `:8090/sys/admin/console-config`    | browser → Console | Runtime overrides on allowlisted Console keys (Channels-style; persisted to disk).        |
| REST (diag)    | `:8090/sys/diagnostics/*`           | browser → Console | Console-minted upload URLs for `GetDiagnostics` / `GetLog` artefacts.                     |
| REST (metrics) | `:8090/metrics`                     | Prometheus        | Prometheus scrape endpoint. Unauthenticated (network-ACL'd in prod).                      |
| Health         | `:8090/healthz`, `:8090/readyz`     | k8s → Console     | Liveness / readiness probes. Unauthenticated.                                             |
| Web            | `:5180` (dev)                       | browser           | React + shadcn/ui (Tailwind + Radix) + TanStack Router.                                   |

## Pages

| Path                           | What                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `/`                            | Operator dashboard — alerts summary, metrics, service status.                                             |
| `/inspect/charge-points`       | Fleet view; per-charger AC/DC + power-rating chips, faults filter via `?faults=1`.                        |
| `/inspect/charge-points/$cpId` | Charger detail — connectors, statistics, transactions, diagnostics, device events.                        |
| `/inspect/transactions`        | Active + recent transactions across the fleet.                                                            |
| `/inspect/transactions/$txId`  | Per-transaction detail with kW-per-phase + cumulative-kWh charts.                                         |
| `/sys/alerts?tab=firing`       | Alertmanager-backed firing alerts. Silence button per row.                                                |
| `/sys/alerts?tab=silences`     | Active + pending silences. Expire-now per row.                                                            |
| `/sys/alerts?tab=channels`     | Slack / email / webhook receivers. Add / edit / test / set-default. Console writes Alertmanager's config. |
| `/sys/alerts?tab=rules`        | Read-only display of Prometheus's loaded rules, plus inline CRUD for the `console-managed` rule group.    |
| `/sys/config?tab=console`      | Console keys, with inline edit on the allowlist. Overrides persist to `data/console-overrides.json`.      |
| `/sys/config?tab=gateway`      | Gateway keys. Categories collapsible, sorted by mutability. Active-overrides pinned at the top.           |

## Repo layout

```
apps/
├── server/                       Node + Fastify + ws + kafkajs Console server
│   ├── proto/events/v1/          vendored gateway event schema
│   ├── scripts/                  mint-dev-token, hash-password
│   └── src/
│       ├── auth/                 JWT verification, PoW CAPTCHA, user store (bcrypt)
│       ├── broker/               per-connection subscription state, query resolvers
│       ├── kafka/                Kafka tail + protobuf event-envelope decoder
│       ├── metrics/              Prometheus registry + per-route instrumentation
│       ├── rest/                 typed client to the gateway's /api/v1
│       ├── routes/               auth, ws, sys-status, sys-alerts, sys-config, …
│       ├── store/                channels-store, rules-store, override-store, diagnostics-store
│       └── main.ts               process entry — wires the components
└── web/                          React + shadcn/ui console
    └── src/
        ├── api/                  typed clients (auth, sys, alerts, config, ws)
        ├── components/           AppShell, AlertsPanel, ChannelsPanel, RulesPanel, ConfigView, …
        ├── hooks/                useSubscription, useFiringAlerts, useSilences, useChannels, …
        ├── lib/                  WS context, theme context, alerts derivation, charger-spec
        ├── pages/                LoginPage, SystemPage, FleetPage, ChargerDetailPage, AlertsPage, SystemConfigPage, …
        └── routeTree.ts          manual TanStack route tree

packages/
├── protocol/                     shared WS envelope contract (zod schemas + TS types)
└── api-types/                    types generated from the gateway's OpenAPI spec

deploy/
├── docker-compose.yml            server + web + (optional) prometheus + alertmanager
└── observability/                bundled prometheus.yml, alertmanager.yml, alerts.yml seed
```

## Quick start

Prereqs: Node ≥ 20.10, `pnpm` 9.15 (`corepack prepare pnpm@9.15.0 --activate`),
Docker, and the OCPP gateway running locally on `:8080` with REST + Kafka up.

```bash
pnpm install
pnpm gen:api-types
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
# edit apps/server/.env: set JWT_SECRET, GATEWAY_TOKEN, KAFKA_BROKERS,
# CONSOLE_USERS (one or more username:bcrypthash pairs).
# Optional: set ALERTMANAGER_URL + PROMETHEUS_URL to light up /sys/alerts.

# Hash a password for CONSOLE_USERS:
echo -n "yourPassword" | pnpm --filter @eveys-console/server hash-password

pnpm dev
```

Server on `http://localhost:8090`, web on `http://localhost:5180`. Open
the web URL, sign in with the username/password you put in
`CONSOLE_USERS`. The login form runs a small client-side proof-of-work
CAPTCHA before submitting (~50 ms in a real browser).

The `mint-token` script (`pnpm --filter @eveys-console/server mint-token`)
is also kept as a dev-only fallback for headless tests.

### Docker

Two images. The server is distroless Node 20 (with `promtool` bundled
in for rule validation); the web is nginx serving the static SPA bundle.
Compose ties them together:

```bash
# Set required env (see deploy/docker-compose.yml for all the keys
# the server reads). At minimum:
export JWT_SECRET=$(openssl rand -base64 32)
export GATEWAY_BASE_URL=http://gateway-host:8080
export GATEWAY_TOKEN=...
export KAFKA_BROKERS=kafka-host:9092

docker compose -f deploy/docker-compose.yml up -d --build
```

Server on `:8090`, web on `:5180`.

### Observability

Compose ships an optional Prometheus + Alertmanager pair behind an
`observability` profile so the default `up` stays lean. Bring them up
with:

```bash
docker compose -f deploy/docker-compose.yml --profile observability up -d
```

Prometheus on `:9091`, Alertmanager on `:9093`. The starter scrape
config targets the Console at `server:8090/metrics` and the gateway at
`host.docker.internal:9100/metrics`.

`/sys/alerts` is the operator surface for both. Four tabs:

- **Firing** — what Alertmanager is firing right now. 30 s poll.
  Silence button per row.
- **Silences** — active + pending silences with matchers, comment,
  creator, remaining duration. Expire-now per row.
- **Channels** — manage Alertmanager receivers (Slack / email /
  webhook). Add, edit, remove, send a test alert, switch the default.
  The Console writes `data/alertmanager-managed.yml` and reloads
  Alertmanager — Channels are persisted, not per-pod ephemeral.
- **Rules** — read-only display of loaded Prometheus rule groups, with
  inline CRUD for the `console-managed` group. `promtool check rules`
  runs before every write so a malformed expression can't break
  Prometheus on reload.

Without the observability profile (or with `ALERTMANAGER_URL` /
`PROMETHEUS_URL` unset), each tab renders a "not configured" hint
instead of erroring.

### Runtime configuration

The Configuration page (`/sys/config`) reads from the live process and
edits flow through one of two override stores:

- **Console keys** → `data/console-overrides.json` (persisted across
  restarts). Allowlisted in `apps/server/src/store/override-store.ts`;
  bind-time keys like `HOST`/`PORT`, secrets like `JWT_SECRET`, and
  consumer-state keys like `KAFKA_*` are deliberately excluded.
- **Gateway keys** → the gateway's per-pod in-memory override map
  (ephemeral; cleared on restart). The Console proxies through
  `/sys/gateway-admin-config`.

Each tab surfaces an "Active overrides" section at the top when any
override is in effect, plus a "Reset to env" button on every overridden
row.

## Realtime model

Each browser tab opens one WebSocket. Inside that connection it can:

- **subscribe** to a named query (`charge-points`, `charge-point`,
  `transactions-active`, `meter-history`, `status-history`,
  `device-events`). The server returns a snapshot, then a stream of
  deltas. A single Kafka event can fan out to multiple deltas (e.g.
  one MeterValues report carries N samples → N appends; one
  StatusNotification produces one `device-events` row plus one
  `status-history` row).
- **unsubscribe** when the component unmounts.
- **rpc** to issue OCPP commands (`remote-start`, `remote-stop`,
  `reset`); the server forwards to the gateway's REST and relays the
  response back over the same WebSocket.

The wire format is defined in `packages/protocol/`. zod schemas
validate every message in both directions; both apps import the same
schemas so the contract is enforced symmetrically.

Snapshot+tail consistency is **read-after-write with dedup**: the
client keys collection rows by primary ID so the small window between
the snapshot fetch and the first delta is harmless. The FleetPage
reduces snapshot + latest delta into a `Map<cp_id, row>` on every
render.

Wire payloads from Kafka are protobuf-encoded `EventEnvelope`s (the
gateway's own schema, vendored at `apps/server/proto/events/v1/`).
The decoder lives in `apps/server/src/kafka/event-decoder.ts`.

Per-transaction detail (`/inspect/transactions/$txId`) is REST-polled
rather than WS-subscribed: the WS broker only carries the active-tx
list query, and an operator opening one session detail isn't watching
it for hours. The page calls the Console's `/sys/transactions/:txId`
and `/sys/charge-points/:cpId/meter-values` proxies (server-side
forwarders to the gateway), then renders kW-per-phase and cumulative
kWh charts using Recharts. Open sessions refetch every 5 s; closed
sessions render a fixed window.

Firing alerts + silences + channels + rules are also REST-polled
through the Console (30 s) rather than WS-subscribed — they change on
the order of minutes, not seconds, and the broker isn't the right
place for per-tab control-plane data.

## Diagnostics uploads

OCPP `GetDiagnostics` and `GetLog` ask the charger to PUT its log file to a
URL the operator supplies. Today the operator can either type any URL
(legacy path; kept) or have the Console mint a one-shot URL bound to the
command. When the latter is checked in the GetDiagnostics / GetLog form,
the form first calls `POST /sys/diagnostics/issue` to mint a 32-byte token
embedded in `…/uploads/diag/<token>`, then sends the OCPP command with that
URL. The charger PUTs (or POSTs) the file back; the Console writes it to
`data/uploads/<cp_id>/<request_id>` and records token, timestamps, byte
count and SHA-256 in a SQLite metadata table at `data/console.sqlite`.

The artefact appears under the device page's **Diagnostics history**
card within one 5-second poll. From there, downloads stream back through
the Console; delete drops the row and the file.

Token rules: 32 random bytes (64 hex chars), one-shot, default TTL 1 hour
(`DIAGNOSTICS_UPLOAD_TTL_SECONDS`). Pending tokens past their `expires_at`
are rolled to `expired` lazily on every issue and upload — no cron needed.
Body cap defaults to 50 MB (`DIAGNOSTICS_MAX_UPLOAD_BYTES`); enforced
per-route, so other routes are unaffected.

Reachability is dev-only today: chargers reach the Console via the same
host:port the operator's browser does, so this works on a laptop or
inside a docker-compose network. Production ingress (TLS, public DNS,
multi-pod fan-in, object storage) is a separate iteration.

## Build, test, ship

```bash
pnpm format        # prettier
pnpm typecheck     # tsc --noEmit across all packages
pnpm test          # vitest, all packages (~600 tests)
pnpm build         # tsc + vite build, both apps
```

CI runs `format:check + typecheck + test + build` on every PR, plus a
`validate-observability` job that runs `promtool check config` /
`check rules` and `amtool check-config` against the bundled
`deploy/observability/` files.

## License

Apache-2.0. See [`LICENSE`](./LICENSE) for the licence text and
[`NOTICE`](./NOTICE) for attribution and trademark notices.
