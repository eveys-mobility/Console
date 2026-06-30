# eveys-console

[![CI](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml/badge.svg)](https://github.com/eveys-mobility/Console/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Sign-in protected operator console for the
[eveys-mobility/OCPP](https://github.com/eveys-mobility/OCPP) gateway.
React + shadcn/ui + TanStack Router on the front end; Fastify with
one WebSocket per tab carrying snapshot + tail subscriptions on the
server. Bcrypt'd username/password with a client-side proof-of-work
CAPTCHA; short-lived JWTs after that.

---

## Quickstart

The Console expects the OCPP gateway to be reachable already — see
the [gateway quickstart](https://github.com/eveys-mobility/OCPP#quickstart)
for that side. Once it's running:

```bash
corepack prepare pnpm@9.15.0 --activate     # Node 20+, pnpm 9.15

git clone git@github.com:eveys-mobility/Console.git eveys-console
cd eveys-console

pnpm install
pnpm gen:api-types
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example    apps/web/.env
# Edit apps/server/.env: at minimum set JWT_SECRET, GATEWAY_TOKEN
# (matching the gateway's REST_INBOUND_TOKENS), KAFKA_BROKERS, and
# the CONSOLE_USERNAME / CONSOLE_PASSWORD pair.

pnpm dev
```

The web app opens on `http://localhost:5180`; the Fastify server lives
on `http://localhost:8090`. Sign in with the credentials you put in
the `.env`. The login form runs a small proof-of-work before
submitting — about 50 ms of CPU in a real browser, enough to make
credential-stuffing unattractive without bothering the operator.

If you'd rather run everything in Docker, `docker compose -f
deploy/docker-compose.yml up -d --build server web` does the
equivalent. The compose file declares the gateway's network as an
external dependency, so the server can reach the gateway's Kafka
through the internal listener without the advertised-listener mismatch
you'd hit going via `host.docker.internal`.

## Updating

`sh scripts/updater.sh` pulls the latest, rebuilds the server and web
images, and recreates the containers in place. There's no database —
the Console keeps state in a small SQLite for diagnostics and a JSON
file for runtime overrides, both inside a named volume — so an update
is just a rebuild. On hosts marked `EVEYS_ENV=production` the script
asks for confirmation before recreating. `FORCE_PROD=1` skips the
prompt.

Updating the gateway is a separate operation that lives in the
[gateway repo](https://github.com/eveys-mobility/OCPP) (`make update`
there).

## What's where

The operator dashboard at `/` is the landing page — a summary of
firing alerts, headline metrics (chargers online, sessions in
flight, faults), and service status. Everything else is reachable
from the sidebar:

- **`/inspect/charge-points`** lists the fleet with AC/DC + power
  chips and a faults filter. Each row links to a per-charger detail
  page that shows connector state, active and recent sessions,
  diagnostics history, and a live device-event feed.
- **`/inspect/transactions`** is the cross-fleet session view with
  date and stop-reason filters. Click into a transaction for a live
  detail page — kW per phase and cumulative kWh charts that refresh
  the moment a MeterValues arrives.
- **`/sys/alerts`** is the operator's view of Prometheus and
  Alertmanager: firing alerts, active silences, channels for Slack /
  email / webhook receivers, and inline CRUD for a Console-managed
  rule group with `promtool check rules` running before every save.
- **`/sys/authorizations`** is the operator-driven charger
  allowlist. Pending registrations bubble up here for approval before
  a new charger is accepted into the fleet.
- **`/sys/ocpp-config`** lets the operator tune the keys the
  gateway pushes via ChangeConfiguration after every Accepted
  BootNotification — heartbeat interval, connection timeout, the
  transaction retry knobs. Edits apply on the next boot of each
  charger; no gateway restart is needed.
- **`/sys/config`** is two tabs of runtime overrides — one for the
  Console's own keys (persisted to disk), one for the gateway's
  per-pod override map (cleared on gateway restart).

The realtime layer is a single WebSocket per tab. The browser
subscribes to one or more named queries (`charge-points`,
`transactions-active`, `meter-history`, etc.) and gets back a
snapshot followed by deltas; the server fans the gateway's Kafka
topics into deltas and re-fetches REST rows when a topic event
mutates them.

## Configuration

The server reads its configuration from `apps/server/.env`. The
example file (`apps/server/.env.example`) covers the values most
operators need to touch — JWT secret, gateway token and base URL,
Kafka brokers, login credentials, optional Alertmanager and
Prometheus URLs. The web side (`apps/web/.env`) only matters when
the Console server is on a different host than the web app — by
default the client builds its URLs from `window.location`.

Inside the running process, a smaller set of keys are flippable
without a restart. The Configuration page surfaces both, with
inline editors for the allowlisted ones and a "Reset to env" button
for any overrides in effect.

## Repository layout

The repo is a pnpm workspace:

- `apps/server/` is the Fastify server — authentication, REST proxies
  to the gateway, the WebSocket broker, the Kafka tail, Prometheus
  metrics.
- `apps/web/` is the SPA — React, shadcn/ui, TanStack Router and
  Query, Recharts for the live charts.
- `packages/protocol/` is the WebSocket envelope contract — zod
  schemas shared by both apps so the wire shape is enforced on both
  ends.
- `packages/api-types/` is generated from the gateway's OpenAPI spec,
  so REST callers stay typed.
- `deploy/` carries the production-shaped Dockerfiles plus the
  observability bundle (Prometheus + Alertmanager) that comes up
  behind a profile flag.

## Commands

Top-level workspace verbs, fanned out across `apps/` and `packages/`
via `pnpm -r`. Equivalent to the gateway's `make` targets in spirit
— same grouping, different runner.

**Setup**

| Target | What it does |
|---|---|
| `corepack prepare pnpm@9.15.0 --activate` | Pin the pnpm version so `pnpm install` matches CI. One-time. |
| `pnpm install` | Install workspace deps. Idempotent. |
| `pnpm gen:api-types` | Regenerate `packages/api-types/` from the gateway's OpenAPI spec. Re-run after the gateway exports a new spec. |

**Day-to-day**

| Target | What it does |
|---|---|
| `pnpm dev` | Run both `apps/server/` and `apps/web/` in watch mode. Web on `:5180`, server on `:8090`. |
| `pnpm --filter @eveys-console/server dev` | Only the server. Restarts on `apps/server/.env` changes. |
| `pnpm --filter @eveys-console/web dev` | Only the web (Vite). |
| `pnpm --filter @eveys-console/server mint-token` | Print a dev JWT for headless testing without going through the login form. |
| `pnpm --filter @eveys-console/server hash-password` | Bcrypt a password for `CONSOLE_USERS`. |

**Code quality**

| Target | What it does |
|---|---|
| `pnpm format` | Prettier across the workspace. |
| `pnpm format:check` | Prettier in check mode (CI gate). |
| `pnpm lint` | ESLint across both apps. |
| `pnpm typecheck` | `tsc --noEmit` across both apps. |
| `pnpm test` | Vitest across both apps. |
| `pnpm build` | Production bundle (`tsc` for the server, `tsc + vite build` for the web). |

**Deployment**

| Target | What it does |
|---|---|
| `sh scripts/updater.sh` | One-shot rebuild → recreate `server` + `web` containers → poll `/api/healthz`. Never tears the stack down. `--server-only` / `--web-only` scope it. |
| `docker compose -f deploy/docker-compose.yml up -d --build server web` | The same effect without the polling and the production-safety prompt. |
| `docker compose -f deploy/docker-compose.yml --profile observability up -d` | Add the Prometheus + Alertmanager pair (`:9091`, `:9093`). |

CI runs `format:check + typecheck + test + build` on every PR plus a
`promtool check` and `amtool check-config` against the bundled
`deploy/observability/` files.

## Contributing and license

Issues and PRs are welcome. Run `pnpm format` and `pnpm typecheck`
before pushing.

Released under the Apache License, Version 2.0 —
[`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE).
