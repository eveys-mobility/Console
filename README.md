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

cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example    apps/web/.env
# Edit apps/server/.env: at minimum set JWT_SECRET, GATEWAY_TOKEN
# (matching the gateway's REST_INBOUND_TOKENS), KAFKA_BROKERS, and
# the CONSOLE_USERNAME / CONSOLE_PASSWORD pair.

make doctor             # verify system prerequisites are ready
make install            # gated on `make doctor`; pnpm install + regenerate api-types
make dev                # apps/server + apps/web in watch mode
```

`make doctor` inspects every required tool (Node 20+, pnpm 9.15,
Docker + Compose v2, git, make) against a minimum version and prints
a one-line diagnosis per tool. Run it whenever `make install` or
`make dev` starts failing in an unfamiliar way — it will point at
the missing or out-of-date piece. `make install` invokes it first
and refuses to run if a required tool is missing.

The web app opens on `http://localhost:5180`; the Fastify server lives
on `http://localhost:8090`. Sign in with the credentials you put in
the `.env`. The login form runs a small proof-of-work before
submitting — about 50 ms of CPU in a real browser, enough to make
credential-stuffing unattractive without bothering the operator.

If you'd rather run everything in Docker, `make compose-up` builds
the images and brings the containers up; `make compose-status` and
`make compose-logs` follow from there. The compose file declares the
gateway's network as an external dependency, so the server reaches
Kafka via the internal listener without any advertised-listener
mismatch.

## Updating

`make update` runs the full quality chain before it touches docker —
`make format` (auto-fixes prettier drift) → `make build` (the CI
gate: format-check → typecheck → test → tsc + vite build) →
`scripts/updater.sh` (pull → docker rebuild → server-init chown →
recreate in place → poll `/api/healthz`). Any gate failure aborts
before docker is touched, so a broken local tree can't ship. The
script never tears the stack down, so it's safe on a live host.

There's no database to migrate: the Console keeps state in a small
SQLite for diagnostics and a JSON file for runtime overrides, both
inside a named volume, so an update is just a rebuild.

Knobs: `NO_PULL=1` skips the `git pull`; `SERVER_ONLY=1` or
`WEB_ONLY=1` narrow the docker recreate; `SKIP_GATES=1` is the
emergency escape when you're rolling a known-good bundle and don't
want to wait for the gates. On hosts marked `EVEYS_ENV=production`
the updater asks for confirmation before recreating containers;
`FORCE_PROD=1` skips the prompt.

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

Times in the UI render in the operator's local zone with a
`±HH:MM` offset suffix on the hover tooltip (e.g.
`2026-06-30 21:36:29 +03:00`). The offset stays in the string so a
screenshot of the UI is still unambiguous when correlated with the
UTC log lines the gateway emits.

## Configuration

The server reads its configuration from `apps/server/.env`. The
example file (`apps/server/.env.example`) covers the values most
operators need to touch — JWT secret, gateway token and base URL,
Kafka brokers, login credentials, optional Alertmanager and
Prometheus URLs.

The web side (`apps/web/.env`) only matters when the Console server
isn't reachable on the same `${hostname}:8090` the SPA would default
to — i.e. when there's a reverse proxy in front, or when the API
lives on a different host. Two keys, both Vite build-time:

```bash
# apps/web/.env — either form works; both produce the same final URL
VITE_CONSOLE_BASE_URL=https://console.example.com
# or:
# VITE_CONSOLE_BASE_URL=https://console.example.com/api

VITE_WS_URL=wss://console.example.com
# or:
# VITE_WS_URL=wss://console.example.com/ws
```

These are **build-time** — Vite inlines them into the bundle.
`make update` picks them up automatically as docker build args,
and a content digest of `apps/web/.env` flows through as a
cache-buster, so any byte change in that file reliably invalidates
the `pnpm build` layer on the next update — no manual
`--no-cache` needed.

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

## Make targets

The verbs you'll actually reach for, grouped by when. `make help`
prints the live list. Each one wraps the matching `pnpm` command or
`docker compose` invocation so the day-to-day flow doesn't depend on
remembering filter flags.

**Environment**

| Target        | What it does                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make doctor` | Verify the system is ready to install (Node 20+, pnpm 9.15, Docker + Compose v2, git, make). Runs automatically as the first step of `make install`; you can also run it standalone whenever `make dev` or `make install` starts complaining. |

**Setup**

| Target                | What it does                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make install`        | `make doctor` (fail-fast on missing tools) → `pnpm install` → regenerate `packages/api-types/` from the gateway's OpenAPI spec → build the workspace packages (`api-types` + `protocol`). |
| `make gen-api-types`  | Just the regenerate step. Re-run after the gateway publishes a new spec.                                                                                                                  |
| `make build-packages` | Build the workspace packages (`api-types` + `protocol`) so `apps/web` can resolve them through vite.                                                                                      |

**Day-to-day**

| Target               | What it does                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- |
| `make dev`           | Run `apps/server` and `apps/web` in watch mode (server on `:8090`, web on `:5180`). |
| `make mint-token`    | Print a dev JWT for headless testing without going through the login form.          |
| `make hash-password` | Bcrypt a password for `CONSOLE_USERS`.                                              |

**Code quality**

| Target                              | What it does                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `make format` / `make format-check` | Prettier across the workspace, write or check.                                                                                    |
| `make lint`                         | `format-check + typecheck` — the gates CI actually runs. (ESLint isn't installed in this workspace.)                              |
| `make typecheck`                    | `tsc --noEmit` across both apps.                                                                                                  |
| `make test`                         | Vitest across both apps.                                                                                                          |
| `make build`                        | **Full CI gate**: `format-check → typecheck → test → tsc + vite build`. Any earlier failure aborts before the bundle is produced. |

**Local stack (Docker)**

The gateway must be running first — the Console's compose file declares
`eveys-ocpp_default` as an external network so the server can reach the
gateway's Kafka over the internal listener. Bring it up with
`make compose-up` in [the gateway repo](https://github.com/eveys-mobility/OCPP)
before anything below.

| Target                                  | What it does                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make compose-up`                       | Build → server-init chown → recreate `server` + `web` → poll `/api/healthz`. Delegates to `scripts/updater.sh --no-pull` so the env translation is applied. |
| `make compose-status`                   | Container health.                                                                                                                                           |
| `make compose-logs`                     | Tail server + web logs.                                                                                                                                     |
| `make compose-down`                     | Stop containers, keep the named volume. _(production-gated)_                                                                                                |
| `make compose-down-volumes`             | Stop **and wipe** the `console-data` volume. _(production-gated, asks for confirmation)_                                                                    |
| `make build-images`                     | Build the images without recreating.                                                                                                                        |
| `make grafana-up` / `make grafana-down` | Opt-in Prometheus + Alertmanager pair on `:9091` / `:9093`. _(grafana-down is production-gated)_                                                            |

**Deployment**

| Target        | What it does                                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make update` | `format` (auto-fix) → `build` (the full CI gate above) → `scripts/updater.sh`. Any failure in the gates aborts before docker is touched. `NO_PULL=1` skips `git pull`; `SERVER_ONLY=1` / `WEB_ONLY=1` scope the docker recreate; `SKIP_GATES=1` is the emergency escape (rollback known-good bundle). |

**Cleanup**

| Target           | What it does                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `make clean`     | Drop `dist/`, `.turbo`, Vite caches. Keeps `node_modules`.               |
| `make distclean` | `clean` + drop `node_modules` across the workspace. _(production-gated)_ |

### Production safety

Set `EVEYS_ENV=production` in the shell or in `.env`, and `compose-down`,
`compose-down-volumes`, `grafana-down`, and `distclean` refuse to run
unless `FORCE_PROD=1` is passed on the same command line. The override
is per-invocation by design — it can't quietly stay on.

CI runs `format-check + typecheck + test + build` on every PR plus a
`promtool check` and `amtool check-config` against the bundled
`deploy/observability/` files.

## Contributing and license

Issues and PRs are welcome. Run `pnpm format` and `pnpm typecheck`
before pushing.

Released under the Apache License, Version 2.0 —
[`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE).
