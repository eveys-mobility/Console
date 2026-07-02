# ADR-0007 — JWT in the WebSocket `Sec-WebSocket-Protocol` header

- **Status**: Accepted (revisit when httpOnly cookie auth lands)
- **Date**: 2026-05-09
- **Author**: Eveys engineering

## Context

The console authenticates every WebSocket connection with a JWT.
The browser API for WebSocket — `new WebSocket(url, protocols)` —
provides no way to set arbitrary headers, so the standard tricks
for bearer tokens on HTTP requests don't apply. The options are:

- **Cookies**. The browser sends cookies on the WS upgrade if the
  endpoint is same-origin. Token can be httpOnly; XSS can't read it.
- **Query string**. Append `?token=...` to the WS URL. Simple but
  the token ends up in proxy logs, browser history, etc.
- **`Sec-WebSocket-Protocol`**. The browser does set this header on
  the upgrade; the server can echo back the protocols it accepts.
  Encoding the JWT as one of the requested subprotocols (e.g.
  `bearer.<jwt>`) is a documented pattern (Kubernetes, Hasura,
  AppSync all use it).
- **Token-via-first-message**. WS upgrade is anonymous; the first
  message is a `auth` envelope; the server closes the WS if it
  doesn't get a valid one within N seconds.

Constraints:

- The browser can't set `Authorization: Bearer ...` on a
  WebSocket. That's the deal-breaker for the obvious option.
- We don't have a same-origin reverse proxy in front of the console
  yet; the browser at `localhost:5180` connects to the Console at
  `localhost:8090`. Cookies on cross-origin WS upgrades require
  CORS-like negotiations browsers don't do.
- We want auth checked _before_ allocating per-connection state, not
  after the WS is open.

## Decision

The browser opens the WS with two `Sec-WebSocket-Protocol` values:

```
eveys-console-v1
bearer.<jwt>
```

The server picks `eveys-console-v1` as the negotiated subprotocol
and parses the JWT out of the second token. Auth happens during the
upgrade; failure closes the socket with code 4401 before any
messages are exchanged.

## Alternatives considered

- **Query-string token**. Rejected for the proxy-log / browser-
  history exposure. Tokens leaking into URLs are a recurring source
  of credentials in dumps.
- **Cookie auth**. Rejected for v1 because we don't have a same-
  origin reverse proxy. The path forward is documented: when
  Cloudflare/Nginx fronts both the web and the Console, switch to
  httpOnly cookie + CSRF token. See `docs/07-security.md`.
- **Auth-on-first-message**. Rejected because the server still
  allocates a WS connection (a TCP socket, file descriptor, ws
  state) before knowing whether the principal is real. Cheap in
  local dev, expensive under abuse.

## Consequences

### Positive

- Auth happens during the upgrade. Bad tokens never reach the
  message-dispatch loop.
- Standard pattern; well-supported by Kubernetes ecosystem
  (Hasura, AppSync, Buf Connect) so any tooling that has to talk
  to the console can copy a known shape.
- No same-origin requirement; works across `localhost` ↔
  `127.0.0.1` and across deploys with separate UI / API hostnames.

### Negative / costs

- The JWT lives in `localStorage` on the web side because the
  client needs to construct the subprotocol value from JS. XSS
  exfiltrates it. Documented as a known issue in
  `docs/07-security.md`; the path to httpOnly cookies is the v2
  fix.
- The token is visible in browser DevTools' Network tab during the
  upgrade. Same as any bearer token over plaintext.

### Risks

- **Token theft via XSS.** The console mitigates by being a small,
  no-third-party-script app and serving its own bundle. shadcn/ui
  - Tailwind components don't pull external script tags. Long
    term: cookie auth.

### Reversibility

Reversible. Adding cookie support means: server reads
`req.headers.cookie` first, falls back to subprotocol; web sets the
JWT as a Set-Cookie response from `/auth/login` and stops sending
the subprotocol. Both clients work side-by-side during cutover.

## References

- `apps/server/src/routes/ws.ts` — handshake handler.
- `apps/web/src/api/ws-client.ts` — subprotocol construction.
- `docs/07-security.md` — known XSS issue and the cookie-auth path.
