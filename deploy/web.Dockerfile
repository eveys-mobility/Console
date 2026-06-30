# Static web bundle served by nginx.
#
# Builds the SPA from source then serves dist/ behind a tiny nginx.
# The image takes the Console-server URL via an env var rendered into
# nginx.conf at boot — see entrypoint.sh.

# ---- builder ---------------------------------------------------------------

FROM node:20.10.0-bookworm-slim AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# node-gyp build prerequisites — the workspace install pulls in
# `better-sqlite3` from the server package even though the web bundle
# never touches it, and node-gyp needs python3 + a C++ toolchain to
# compile when no prebuild matches the target arch. Without these the
# install step fails with "gyp ERR! not ok" on better-sqlite3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/api-types/package.json ./packages/api-types/

RUN --mount=type=cache,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

RUN pnpm --filter @eveys-console/api-types run generate \
 && pnpm --filter @eveys-console/protocol run build \
 && pnpm --filter @eveys-console/web run build

# ---- runtime ---------------------------------------------------------------

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
