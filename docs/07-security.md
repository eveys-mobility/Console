# 07 — Security

> Decisions captured as ADRs in [`docs/adr/`](./adr/). Most relevant
> here: [ADR-0007](./adr/0007-jwt-in-ws-subprotocol-header.md)
> (JWT in the WS subprotocol header),
> [ADR-0008](./adr/0008-self-hosted-pow-captcha.md) (self-hosted PoW
> CAPTCHA).

This document is the threat model for the Console and the console UI.
The realtime console is an operator tool that exposes:

- Read access to every charger in the fleet (snapshots + live deltas).
- Write access to the gateway's command surface
  (`RemoteStart`, `RemoteStop`, `Reset`, …).

A compromise of the Console therefore means an attacker can read fleet
state and stop or restart any charger. Treat it accordingly.

## Mandatory before any non-loopback deployment

The server **refuses to start** if `JWT_SECRET` is a known placeholder
_and_ `HOST` is not loopback. The check lives in `apps/server/src/config.ts`.
Set a strong secret (`openssl rand -base64 48`) before binding a
public interface.

## Authentication

Two paths to a JWT, both valid:

1. **Login form** — `POST /auth/challenge` then `POST /auth/login`
   with username + password (verified against bcrypt hashes in
   `CONSOLE_USERS`) + a proof-of-work solution. Per-IP rate limit on
   `/auth/login` (default 5/min, configurable via
   `AUTH_LOGIN_MAX_PER_MIN`).
2. **`mint-token` script** — signs a JWT directly with `JWT_SECRET`.
   Bypasses the user store; for headless tests only.

Both paths produce the same envelope: HS256 JWT, audience
`JWT_AUDIENCE`, issuer `JWT_ISSUER`, TTL `JWT_TTL_SECONDS` (default
8 h).

WebSocket connections carry the JWT in the `Sec-WebSocket-Protocol`
header (`bearer.<jwt>`). Expired or unsigned tokens close the WS
with code 4401.

### Status

- Dev: HS256 with a static secret. Acceptable for local dev only.
- Production: **must move to RS256 + JWKS**. Plug into your IdP
  (Keycloak, Auth0, Cognito, custom). The verify call lives in one
  place — `apps/server/src/auth/jwt.ts` — change the `secret` option
  to a JWKS resolver function.

### Open issues

- HTTP CORS is wired (`@fastify/cors` with optional `ALLOWED_ORIGINS`
  allow-list). The **WebSocket handshake does not check Origin** —
  the server should still reject WS opens whose `Origin` header isn't
  an allow-listed UI domain. Browsers don't preflight WS, so this is
  a real hole on a public deploy.
- `mint-token` and `hash-password` scripts sign / hash with the same
  secret store as the running server. Shell access on the deploy
  host = ability to mint admin tokens. **Strip these scripts from
  production images.**
- Web app stores the JWT in `localStorage`. XSS exfiltrates the
  token. Production should switch to httpOnly cookies + CSRF tokens
  for the WS upgrade, or short-lived (minutes) JWTs auto-refreshed
  by a session endpoint.

## Authorisation

- The `Principal.roles` field is parsed and attached to the
  connection context — but **no code path enforces role checks**.
- Multi-tenancy is unwired. Every authenticated user sees every
  charger; the Console does not filter by `tenant_id` or `cp_id` ACL
  before fan-out.

### Status

- v1 is single-tenant, role-flat. **Acceptable only inside a private
  network where every authenticated user is trusted.**

### Open issues (must fix before multi-tenant launch)

- Add a `requireRole(role)` middleware for RPC dispatch.
  `RemoteStart` should require an `operator` role; `Reset` should
  require `admin`.
- Wire a `cp_id → tenant_id` lookup in the broker.
  Filter every event before fan-out so connection T only sees
  events for tenant T's chargers.
- The principal's `tenant_id` claim must be a server-side fact (set
  by the IdP at login), never a client-side hint.

## Transport

- WebSocket frames are JSON over plaintext today. Behind a proper
  reverse proxy (Nginx, Envoy, Cloudflare) terminate TLS at the
  edge so the Console never sees plaintext clients.
- The Console makes outbound HTTPS calls to the gateway with a static
  bearer token (`GATEWAY_TOKEN`). The token must be a _service
  token_ unique to this Console, with the minimum gateway permissions
  it needs. Don't reuse operator tokens.

## Rate limiting and DoS

What's wired:

- **Per-IP rate limit on `/auth/login`** via `@fastify/rate-limit`.
  Default 5 attempts/minute, configurable via
  `AUTH_LOGIN_MAX_PER_MIN`.
- **Proof-of-work CAPTCHA** on the login form — adds ~50–100 ms of
  CPU work per attempt in a real browser, more for higher
  `AUTH_POW_DIFFICULTY`. Won't stop a determined attacker but
  trivially blocks dumb credential-stuffing scripts that don't
  bother computing it.

What's not yet wired:

- No per-connection rate limit on the WS. A single connection can
  spam subscribe/unsubscribe/RPC and the server will dispatch every
  message.
- `WS_MAX_SUBSCRIPTIONS_PER_CONN` exists in config but isn't
  enforced.
- No `cp.meter` coalescing — one delta per sample per Kafka event.
  A noisy charger can flood every subscriber.

Mitigations to add before public deploy:

- Per-connection token bucket on the WS (e.g., 50 messages / s).
- Enforce `WS_MAX_SUBSCRIPTIONS_PER_CONN`.
- Per-IP connection limit at the reverse proxy (Envoy `ratelimit`
  filter or Nginx `limit_conn`).
- Coalesce `cp.meter` deltas server-side — one per connection per
  N seconds, not one per Kafka event.

## Secrets handling

- `JWT_SECRET` and `GATEWAY_TOKEN` live in `apps/server/.env` for
  dev. Never commit these. The `.gitignore` excludes `.env` files.
- For production: load from a secret manager (Vault / AWS Secrets
  Manager / k8s `Secret`), not from `.env`. Mount as env vars at
  process start.

## Deploy posture (recommended)

```
            ┌──────────────────┐
            │  Cloudflare /    │  TLS, WAF, per-IP rate limit
            │  Envoy / Nginx   │
            └────────┬─────────┘
                     │ wss://, only allow-listed Origin
                     ▼
            ┌──────────────────┐
            │  Console pod        │  bind :8090 on private network
            │  (apps/server)   │  JWT_SECRET via secret manager
            └────────┬─────────┘
                     │
                     ▼
            ┌──────────────────┐
            │  Gateway         │  service token, scoped permissions
            └──────────────────┘
```

Three checkpoints between attacker and damage:

1. The reverse proxy enforces TLS, Origin, and rate limits.
2. The Console verifies the JWT and (eventually) tenant ACLs.
3. The gateway authenticates the Console's service token.

## What still bites you on a private network

Even on a fully private network, the unenforced role and
multi-tenancy issues mean:

- Any logged-in operator can `RemoteStop` any charging session,
  including ones in the middle of paid charging events.
- Any logged-in operator can `Reset` any charger, breaking active
  sessions.
- Audit logging is not implemented — there's no record of _which_
  operator issued a destructive command.

Audit logging (every RPC call, with principal sub + cp_id +
timestamp + outcome, append-only to a separate sink) is the next
security-shaped feature to add. It's small and high-value.
