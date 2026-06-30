# Console server image. Multi-stage build:
#   1. builder: pnpm install + workspace build
#   2. runtime: distroless Node 20 with the pruned production deps
#
# The web SPA (apps/web/dist) is NOT served from this image — it is a
# static bundle deployed behind nginx (see deploy/web.Dockerfile). This
# keeps the server image small and the SPA cacheable / CDN-friendly.

# ---- builder ---------------------------------------------------------------

FROM node:20.10.0-bookworm-slim AS builder
WORKDIR /repo

# Pin pnpm via Corepack so the build doesn't depend on whatever the host
# image happens to ship.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# node-gyp build prerequisites for native modules. `better-sqlite3`
# (the diagnostics + authorizations store, added in #3) ships
# C++ sources and needs python3 + build-essential to compile when a
# prebuild for the target arch isn't available — the slim base image
# strips both. Without these, `pnpm install` exits with
# "gyp ERR! not ok" on the better-sqlite3 install script.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install all workspace dependencies (dev + prod) so the build can run.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/api-types/package.json ./packages/api-types/

RUN --mount=type=cache,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile

# Copy sources and build.
COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @eveys-console/api-types run generate \
 && pnpm --filter @eveys-console/protocol run build \
 && pnpm --filter @eveys-console/server run build

# Produce a self-contained server bundle with only the production deps
# it actually needs. `pnpm deploy` rewrites the workspace symlinks into
# real copies under /deploy.
RUN pnpm --filter @eveys-console/server --prod deploy /deploy

# ---- promtool --------------------------------------------------------------
#
# Pull `promtool` from the official Prometheus image so the Console can
# validate rule definitions before writing the managed file (via the
# /sys/alerts Rules tab). Pinned to the same version compose runs to
# avoid version-skew false positives. The Console looks for promtool at
# PROMTOOL_PATH (defaults to `promtool` on PATH).

FROM prom/prometheus:v3.0.1 AS promtool

# ---- runtime ---------------------------------------------------------------

FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=builder /deploy/dist ./dist
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /repo/apps/server/proto ./proto
COPY --from=builder /deploy/package.json ./package.json
# Force +x: the prom/prometheus image owns /bin/promtool as a non-root
# uid that distroless `nonroot` can't always execute. The --chmod
# guarantees the runtime user can spawn it.
COPY --from=promtool --chmod=0755 /bin/promtool /usr/local/bin/promtool

EXPOSE 8090
USER nonroot
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090

CMD ["dist/main.js"]
