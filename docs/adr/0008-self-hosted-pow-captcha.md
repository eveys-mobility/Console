# ADR-0008 — Self-hosted proof-of-work CAPTCHA on login (vs reCAPTCHA / Turnstile)

- **Status**: Accepted
- **Date**: 2026-05-09
- **Author**: Eveys engineering

## Context

The console's login form is a classic credential-stuffing target.
Without any anti-automation control, a script can post 1000s of
`{username, password}` combos and discover weak passwords. The
options for slowing automated abuse are:

- **Google reCAPTCHA** (v2 / v3 / Enterprise). Well-known; effective.
  Sends user signals to Google, which is a privacy and GDPR
  consideration for an EV-charging console serving operators in
  Europe.
- **Cloudflare Turnstile**. Same shape, fewer privacy concerns
  than Google, runs as a small JS widget. Still a third-party
  script with its own CDN dependency.
- **hCaptcha**. Privacy-positioned; payouts to operators based on
  solve volume. Same third-party-script concern.
- **Self-hosted proof-of-work**. Server issues a signed challenge;
  client computes a hash that satisfies a leading-zeros target;
  server verifies. No third party, no PII, no JS bundle import.
- **Per-IP rate limit only**. Cheapest; doesn't scale to distributed
  attackers using residential proxies.

Forces:

- The console isn't a high-traffic public surface. It serves
  operators, not the open internet. We're defending against dumb
  scripts, not motivated adversaries.
- We don't want to add a third-party dependency that Eveys' privacy
  / compliance review hasn't approved.
- We do want a real cost on every credential attempt, not just an
  IP rate limit (residential proxies defeat IP limits cheaply).

## Decision

**Self-hosted proof-of-work CAPTCHA.** The Console issues an HMAC-
signed challenge `{nonce, difficulty, issuedAt}` from
`POST /auth/challenge`. The browser computes a `solution` such that
SHA-256(challenge + ':' + solution) has at least `difficulty`
leading zero bits. `POST /auth/login` requires the original
challenge plus a valid solution alongside username+password.

Difficulty is configurable (`AUTH_POW_DIFFICULTY`, default 16); 16
≈ 50 ms in a real browser, 20 ≈ 1 s. Combined with a per-IP rate
limit on `/auth/login`.

## Alternatives considered

- **reCAPTCHA / Turnstile / hCaptcha**. Rejected because they're
  third-party scripts that need privacy review and add a CDN
  dependency. The threat model doesn't justify the cost.
- **Per-IP rate limit alone**. Implemented in addition to PoW
  (5/min default). Rejected as the _only_ defence because attackers
  with residential proxies trivially work around it.
- **Argon2 / bcrypt as the work function**. Stronger per-attempt
  cost but requires a server-side state store (the work parameters
  must match what the client computed). Rejected; stateless HMAC
  challenge is simpler.

## Consequences

### Positive

- No third-party dependency. No GDPR / privacy review needed.
- Stateless on the server — the challenge is signed, so verifying
  a solution doesn't require server-side state.
- Configurable difficulty per deploy (local dev: lower; prod: higher).
- Combined with the per-IP rate limit, gives two independent
  controls.
- Tested directly: see `apps/server/test/auth.test.ts`.

### Negative / costs

- Adds ~50 ms of CPU work in the user's browser on every login
  attempt. Imperceptible to humans; deliberately costly to scripts.
- Doesn't stop a determined attacker who's willing to compute the
  PoW. Real defence is the rate limit + bcrypt cost on credential
  verification.
- The user-visible "verifying you are human" stage has to render in
  the LoginPage UI so the delay isn't surprising.

### Risks

- **Difficulty creep**. If we ratchet `AUTH_POW_DIFFICULTY` too
  high, mobile browsers hit timeouts. Mitigation: keep at 16 for
  v1; move higher only with measurement.

### Reversibility

Trivially reversible. The PoW lives in three small files:
`apps/server/src/auth/pow.ts`, `apps/server/src/routes/auth.ts`,
`apps/web/src/api/auth-client.ts`. Replacing with reCAPTCHA / Turnstile
would mean swapping the client-side compute for a widget render and
the server-side verify for an HTTP call to the third party.

## References

- `apps/server/src/auth/pow.ts` — challenge issuance and verification.
- `apps/web/src/api/auth-client.ts` — `solvePow` (client-side compute).
- `docs/07-security.md` — full auth threat model.
