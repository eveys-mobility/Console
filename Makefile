# eveys-console — top-level Makefile.
#
# Mirrors the gateway repo's Makefile shape. Targets are grouped by
# concern. Run `make help` for a printed summary.

# Use bash so `set -euo pipefail` works inside recipe blocks.
SHELL := /usr/bin/env bash

# pnpm is the workspace runner; we pin via Corepack to keep CI and
# local in sync (see `pnpm-lock.yaml` + the .npmrc engine pin).
PNPM ?= pnpm

# Compose driver. Mirrors the gateway's COMPOSE_ENV — passes
# `--env-file apps/server/.env` so the compose interpolation finds
# JWT_SECRET / GATEWAY_TOKEN / KAFKA_BROKERS without forcing the
# operator to `export` everything into the shell. Both repo-root .env
# and apps/server/.env are honoured if present.
COMPOSE_ENV := \
    $(if $(wildcard .env),--env-file .env,) \
    $(if $(wildcard apps/server/.env),--env-file apps/server/.env,)
COMPOSE := docker compose $(COMPOSE_ENV) -f deploy/docker-compose.yml

# Observability profile (Prometheus + Alertmanager). Opt-in via
# `make grafana-up` — the bundled scrape config + managed rules.
COMPOSE_OBS := $(COMPOSE) --profile observability

.PHONY: help install dev format format-check lint typecheck test build \
        gen-api-types mint-token hash-password \
        compose-up compose-down compose-down-volumes compose-status compose-logs \
        update build-images grafana-up grafana-down \
        clean distclean _require-nonprod

# ---- production safety gate -------------------------------------------------
#
# Same pattern as the gateway. Set EVEYS_ENV=production on hosts where
# Make should refuse anything destructive:
#
#   compose-down              # stops server + web
#   compose-down-volumes      # DESTRUCTIVE: also wipes the console-data volume
#   grafana-down              # removes the observability sidecar
#   distclean                 # wipes node_modules + build artifacts
#
# Override per-invocation with FORCE_PROD=1:
#   make compose-down EVEYS_ENV=production FORCE_PROD=1
#
# Read order: shell env first, then repo-root .env. Stripped of
# surrounding quotes so a .env entry like `EVEYS_ENV="production"`
# is honoured the same as `EVEYS_ENV=production`.
EVEYS_ENV ?= $(shell sh -c '\
	if [ -n "$$EVEYS_ENV" ]; then echo "$$EVEYS_ENV"; \
	elif [ -f .env ]; then \
	  grep -E "^EVEYS_ENV=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\042\047"; \
	fi')

_require-nonprod:
	@if [ "$(EVEYS_ENV)" = "production" ] && [ "$(FORCE_PROD)" != "1" ]; then \
	  echo ""; \
	  echo "REFUSING: target '$(MAKECMDGOALS)' is destructive and EVEYS_ENV=production." >&2; \
	  echo "         It would stop the running stack or wipe data. Set FORCE_PROD=1" >&2; \
	  echo "         to override:" >&2; \
	  echo "             make $(MAKECMDGOALS) FORCE_PROD=1" >&2; \
	  echo ""; \
	  echo "         Safer alternative: scripts/updater.sh rebuilds and recreates in" >&2; \
	  echo "         place without tearing the stack down." >&2; \
	  exit 1; \
	fi

# ---- meta -------------------------------------------------------------------

help:
	@echo "Setup:"
	@echo "  make install            install workspace deps + regenerate api-types"
	@echo "  make gen-api-types      regenerate packages/api-types/ from the gateway's OpenAPI spec"
	@echo ""
	@echo "Day-to-day:"
	@echo "  make dev                run apps/server + apps/web in watch mode (server :8090, web :5180)"
	@echo "  make mint-token         print a dev JWT for headless testing"
	@echo "  make hash-password      bcrypt a password for CONSOLE_USERS"
	@echo ""
	@echo "Code quality:"
	@echo "  make format             prettier --write across the workspace"
	@echo "  make format-check       prettier --check (CI gate)"
	@echo "  make lint               eslint across both apps"
	@echo "  make typecheck          tsc --noEmit across both apps"
	@echo "  make test               vitest across both apps"
	@echo "  make build              production bundle (tsc for server, tsc + vite build for web)"
	@echo ""
	@echo "Local stack (Docker):"
	@echo "  make compose-up         build + recreate server + web (passes apps/server/.env)"
	@echo "  make compose-status     container health"
	@echo "  make compose-logs       tail server + web logs"
	@echo "  make compose-down       stop containers, keep volumes"
	@echo "  make compose-down-volumes  stop AND wipe the console-data volume (DESTRUCTIVE)"
	@echo "  make build-images       just build server + web images (no recreate)"
	@echo "  make grafana-up         opt-in Prometheus + Alertmanager sidecar (:9091, :9093)"
	@echo "  make grafana-down       stop the observability sidecar"
	@echo ""
	@echo "Deployment:"
	@echo "  make update             one-shot rebuild + recreate (production-safe; see scripts/updater.sh)"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean              remove dist/, .turbo/, build caches"
	@echo "  make distclean          clean + drop node_modules across the workspace"

# ---- setup ------------------------------------------------------------------

install:
	@command -v $(PNPM) >/dev/null 2>&1 || { \
	  echo "ERROR: pnpm not found. Activate via Corepack:" >&2; \
	  echo "    corepack prepare pnpm@9.15.0 --activate" >&2; \
	  exit 1; \
	}
	$(PNPM) install
	@$(MAKE) gen-api-types

gen-api-types:
	$(PNPM) --filter @eveys-console/api-types generate

# ---- day-to-day -------------------------------------------------------------

dev:
	$(PNPM) dev

mint-token:
	@$(PNPM) --filter @eveys-console/server mint-token

hash-password:
	@$(PNPM) --filter @eveys-console/server hash-password

# ---- code quality -----------------------------------------------------------

format:
	$(PNPM) format

format-check:
	$(PNPM) format:check

lint:
	$(PNPM) lint

typecheck:
	$(PNPM) typecheck

test:
	$(PNPM) test

build:
	$(PNPM) build

# ---- local stack ------------------------------------------------------------

compose-up:
	$(COMPOSE) up -d --build server web

build-images:
	$(COMPOSE) build server web

compose-status:
	$(COMPOSE) ps

compose-logs:
	$(COMPOSE) logs -f --tail 200 server web

compose-down: _require-nonprod
	$(COMPOSE) down

compose-down-volumes: _require-nonprod
	@echo "WARNING: this will DELETE the console-data volume (managed Alertmanager"
	@echo "         config, diagnostics SQLite, override store)."
	@read -p "Continue? [y/N] " ans; [ "$$ans" = "y" ] || [ "$$ans" = "Y" ] || (echo "Aborted." && exit 1)
	$(COMPOSE) down --volumes

grafana-up:
	$(COMPOSE_OBS) up -d prometheus alertmanager
	@echo ""
	@echo "Prometheus:    http://localhost:9091"
	@echo "Alertmanager:  http://localhost:9093"

grafana-down: _require-nonprod
	$(COMPOSE_OBS) stop prometheus alertmanager
	$(COMPOSE_OBS) rm -f prometheus alertmanager

# ---- deployment -------------------------------------------------------------

# One-shot production-safe update: pulls, rebuilds the server and web
# images, recreates the containers in place, polls /api/healthz. Never
# tears the stack down; safe on a live host. Delegates to the same
# script the README documents.
#
#   make update                 # default — pull + rebuild + recreate
#   make update NO_PULL=1       # skip git pull
#   make update SERVER_ONLY=1   # only rebuild + recreate the server
#   make update WEB_ONLY=1      # only rebuild + recreate the web
update:
	@flags=""; \
	if [ "$(NO_PULL)" = "1" ]; then flags="$$flags --no-pull"; fi; \
	if [ "$(SERVER_ONLY)" = "1" ]; then flags="$$flags --server-only"; fi; \
	if [ "$(WEB_ONLY)" = "1" ]; then flags="$$flags --web-only"; fi; \
	sh scripts/updater.sh $$flags

# ---- cleanup ----------------------------------------------------------------

clean:
	@# Drop the build outputs but keep node_modules so subsequent
	@# `make dev` / `make build` is still fast. Matches the gateway's
	@# `clean` vs `distclean` split.
	rm -rf apps/server/dist apps/web/dist packages/protocol/dist packages/api-types/dist
	rm -rf .turbo apps/server/.turbo apps/web/.turbo
	find . -type d -name '.vite' -not -path './node_modules/*' -exec rm -rf {} +

distclean: clean _require-nonprod
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
