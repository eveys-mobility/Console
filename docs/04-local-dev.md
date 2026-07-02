# 04 — Local dev

## Prerequisites

Run `make doctor` from the repo root — it verifies the full list
below against minimum versions and prints one line per tool. On any
Linux server or Mac workstation the same check applies; there is no
platform-specific step.

- Node ≥ 20.10 (any package from <https://nodejs.org/> or your
  distribution's Node 20 package)
- pnpm 9.15 (`corepack prepare pnpm@9.15.0 --activate`)
- The OCPP gateway running locally (the sibling repo
  `eveys-mobility/OCPP`) with:
  - REST reachable on `:8080`
  - `EVEYS_OCPP_REST_INBOUND_TOKENS` set to a real token (copy it into
    the Console's `.env` as `GATEWAY_TOKEN`)
  - `EVEYS_OCPP_REST_OPENAPI_ENABLED=true` so `pnpm gen:api-types` can
    pull the spec (or point at the committed spec file)
  - Kafka reachable on `:9092`

## First boot

```bash
git clone <eveys-console-repo>
cd eveys-console
pnpm install
pnpm gen:api-types

cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
```

Edit `apps/server/.env`:

- `JWT_SECRET` — at least 16 bytes. The server refuses to start with
  the placeholder value bound to anything other than loopback (see
  `docs/07-security.md`).
- `GATEWAY_TOKEN` — copy from the gateway's `EVEYS_OCPP_REST_INBOUND_TOKENS`.
- `KAFKA_BROKERS` — `localhost:9092` for a local gateway compose stack.
- `CONSOLE_USERS` — comma-separated `username:bcrypthash` pairs.
  Generate hashes with the `hash-password` script (see below).

Then:

```bash
pnpm dev
```

Server on `http://localhost:8090`, web on `http://localhost:5180`.

## Setting a login password

`CONSOLE_USERS` takes bcrypt hashes, not plaintext. To add or
rotate a user:

```bash
echo -n "yourPassword" | pnpm --filter @eveys-console/server hash-password
# prints $2a$10$...
```

Paste the hash into `apps/server/.env`:

```
CONSOLE_USERS=admin:$2a$10$abcd...,operator:$2a$10$efgh...
```

Restart the Console so it re-reads `.env`. The login form on
`http://localhost:5180` accepts the new credentials immediately.

## Headless test fallback: mint-token

For scripts and headless tests that can't run the login form, the
server still ships a `mint-token` script that signs a JWT directly
with `JWT_SECRET`:

```bash
pnpm --filter @eveys-console/server mint-token
# pipes a JWT string to stdout — paste manually into a fetch header
```

Don't ship this script in production images — it bypasses the user
store entirely.

## Daily inner loop

```bash
pnpm dev          # both apps with HMR
pnpm typecheck    # ~3 s
pnpm test         # ~3 s
pnpm build        # full prod build
pnpm format       # prettier across the tree
```

## When the gateway's spec changes

Re-run the generator:

```bash
pnpm gen:api-types
```

This rewrites `packages/api-types/src/generated/openapi.ts`. The
file is gitignored — every clone regenerates it. CI runs the same
generator before typecheck.

## When the gateway's Kafka event schema changes

The events `.proto` is vendored at
`apps/server/proto/events/v1/events.proto`. If the gateway publishes
a new field, copy the file from the gateway repo:

```bash
cp /Users/mostafa/eveys/ocpp/proto/events/v1/events.proto \
   apps/server/proto/events/v1/events.proto
```

The proto schema is frozen at v1 in the gateway, so this should
rarely happen.

## Common failure modes

| Symptom                                                                        | Likely cause                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_UNSUPPORTED_ENGINE` on install                                       | Node < 20.10 or pnpm not pinned via corepack. Re-run `corepack prepare pnpm@9.15.0 --activate`.                                                                                                                                        |
| Server refuses to start with "Refusing to start: JWT_SECRET is a placeholder…" | Production guardrail. Set a real `JWT_SECRET` or bind to loopback (`HOST=127.0.0.1`).                                                                                                                                                  |
| Login fails with `login_disabled`                                              | `CONSOLE_USERS` is empty. Add at least one `username:bcrypthash` pair.                                                                                                                                                                 |
| Login fails with `invalid_credentials`                                         | Wrong password, or the bcrypt hash in `.env` doesn't match the password you typed. Re-hash.                                                                                                                                            |
| Login fails with `pow_invalid`                                                 | Browser couldn't compute the proof-of-work in time, or the challenge expired (`AUTH_POW_TTL_SECONDS`, default 120). Refresh and retry.                                                                                                 |
| Pages stuck on "Loading…" forever                                              | Check the browser DevTools network tab. Most likely a cross-origin issue: the page is on a different host than the Console. Check that `VITE_BAAS_BASE_URL` (if set) matches the page's hostname.                                      |
| Snapshot loads but no live updates                                             | The Kafka tail isn't reaching the broker. Check `KAFKA_BROKERS` and that the gateway is publishing. Look for `kafka.envelope_decode_failed` in the Console log — that means the gateway's `.proto` has drifted from the vendored copy. |
| Subscriptions return `unauthenticated`                                         | Token expired (default TTL 8 h). Sign in again.                                                                                                                                                                                        |
| `pnpm gen:api-types` fails to find the spec                                    | Set `GATEWAY_OPENAPI_SPEC=/abs/path/openapi.yaml`. The default discovers `../ocpp/docs/api/openapi.yaml`.                                                                                                                              |
