# Contributing to eveys-console

Thanks for considering a contribution. This document covers the
expectations and the mechanics. Read it once before opening your
first PR; the second one will be muscle memory.

By submitting a contribution you agree that your work will be
licensed under the project's licence (Apache-2.0, see
[`LICENSE`](./LICENSE)).

## Before you start

- **Open an issue first.** Even small changes go through a tracking
  issue so the work is discoverable. For bugs, use the issue to
  describe the symptom and the reproduction; for features, use it
  to confirm the direction before code is written.
- **One PR ↔ one issue.** Reference it from the PR body with
  `Closes #N` (the issue auto-closes on merge) or `Refs #N`
  (related but doesn't close).
- **Big or controversial?** Open the issue first and wait for a
  maintainer thumbs-up before implementing. Saves rework.

## Prerequisites

- Node ≥ 20.10
- pnpm 9.15 (`corepack prepare pnpm@9.15.0 --activate`)
- Docker (only needed when you actually want to run the gateway
  side-by-side; not required for the Console or web)

## Getting started

```bash
git clone git@github.com:eveys-mobility/Console.git
cd Console
pnpm install
pnpm gen:api-types          # regenerates gateway types from the
                            # vendored openapi.yaml
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
# edit apps/server/.env: JWT_SECRET, GATEWAY_TOKEN, KAFKA_BROKERS,
# CONSOLE_USERS (one or more username:bcrypthash pairs)

pnpm dev                    # server :8090 + web :5180 in parallel
```

The README covers the runtime model and the directory layout.

## Branching and commits

- Branch off `main`. Naming: `feature/<short-slug>`, `fix/<short-slug>`,
  `chore/<short-slug>`, `docs/<short-slug>`. Slug is kebab-case and
  describes the _change_, not the issue number.
- Conventional Commits for the title:
  `<type>(<scope>): <subject>` where `<type>` ∈
  `feature`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`,
  `ci`, `build`, `revert`. `<scope>` is optional (e.g. `web`,
  `server`, `protocol`, `readme`).
- Subject in the imperative ("add foo", not "added foo"), no
  trailing period, ≤ 72 chars.
- One logical change per commit; squash trivial fixups locally
  before pushing.

## Pull requests

- **CI must be green.** `format:check`, `typecheck`, `test`, `build`
  all need to pass. The same four steps run locally as
  `pnpm format:check && pnpm typecheck && pnpm test && pnpm build`;
  do that before pushing.
- **New behaviour gets a test.** Server changes ship Vitest cases
  next to the existing suites under `apps/server/test/`; web
  component or hook changes land in `apps/web/test/`.
- **PR body**: state what changed and why; link the issue.
  Screenshots or a short asciinema for visible UI changes are
  welcome.
- **Reviews**: at least one maintainer approval. CI is required.
- **Merge**: squash. The PR title becomes the squash commit; keep
  it precise.
- **History stays linear.** No merge commits on `main`. Rebase
  instead of merging `main` into your branch.

## Code style

- TypeScript strict mode + `exactOptionalPropertyTypes` is enabled
  repo-wide. If the type system is unhappy, fix the types — don't
  reach for `any`, `as unknown as`, or `// @ts-ignore`.
- Prettier owns formatting. Run `pnpm format` before pushing if
  your editor doesn't format on save.
- Names should describe the _what_, not the _how_. Avoid
  abbreviations except for genuinely well-known ones (`id`,
  `url`, `req`, `res`, `db`).
- Comments only when the _why_ is non-obvious. Don't restate
  what the code already says. Don't reference the current task,
  fix, or callers.
- Keep imports ordered: builtins → external packages → workspace
  packages (`@eveys-console/*`) → relative.
- For React components, prefer named exports over default exports.

## Working with the gateway

- The gateway is consumed unchanged. If a change requires touching
  the gateway, it's a separate PR against `eveys-mobility/OCPP`.
- The OpenAPI spec is vendored at
  `packages/api-types/openapi.yaml`. Refresh it from the
  gateway's `docs/api/openapi.yaml` when the gateway adds or
  changes endpoints, then run `pnpm gen:api-types`.
- The protobuf schema is vendored at
  `apps/server/proto/events/v1/`. Same refresh pattern when the
  gateway's event envelope changes.

## Reporting security issues

Do **not** open a public issue for security reports. Email the
maintainers privately with a short description of the issue, a
reproduction if you have one, and an indication of impact. We'll
acknowledge within a few business days, agree on a disclosure
timeline, and credit you in the fix's release notes if you'd
like.

## Code of conduct

Be civil. Disagreements on technical decisions are normal and
welcome — but keep them about the code, not the person. Reports
of harassment or other abuse go to the maintainers privately and
are taken seriously.

## Trademarks

"OCPP" is a registered trademark of the Open Charge Alliance.
"Eveys" and the Eveys wordmark are trademarks of Eveys Mobility.
All other trademarks are the property of their respective owners.
Use of any third-party trademark in this repo is for
identification purposes only.
