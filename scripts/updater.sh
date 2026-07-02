#!/usr/bin/env bash
# scripts/updater.sh — one-shot updater for the eveys-console stack.
#
# Pulls the latest code, rebuilds the `server` and `web` images, and
# recreates the containers in place. No database — the Console has no
# schema of its own. Works on any host running Docker + Compose v2
# (Linux server, workstation, VM).
#
# Usage:
#   scripts/updater.sh                 # pull + rebuild + restart
#   scripts/updater.sh --no-pull       # don't `git pull`
#   scripts/updater.sh --server-only   # rebuild server only (keeps web running)
#   scripts/updater.sh --web-only      # rebuild web only (keeps server running)
#
# Environment overrides:
#   COMPOSE_FILE  Override the compose file path. Defaults to
#                 `deploy/docker-compose.yml` next to the repo root.
#
# Production safety:
#   Set EVEYS_ENV=production (shell env or repo-root .env) on hosts
#   where this script must refuse destructive actions. Today the
#   script never tears containers down — it only rebuilds and
#   recreates — so the gate just prints a warning and continues. Pass
#   FORCE_PROD=1 to silence the warning.
#
# Exit codes:
#   0  success
#   1  precondition failed (missing docker, missing compose file)
#   2  build / restart step failed

set -euo pipefail

# ---------- options ---------------------------------------------------------

DO_PULL=1
DO_SERVER=1
DO_WEB=1
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)     DO_PULL=0; shift ;;
    --server-only) DO_WEB=0; shift ;;
    --web-only)    DO_SERVER=0; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed -n '2,$p' | sed -n '/^#/p' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

COMPOSE_FILE="${COMPOSE_FILE:-${REPO_ROOT}/deploy/docker-compose.yml}"

# ---------- helpers ---------------------------------------------------------

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
fail() { printf 'ERR %s\n' "$*" >&2; exit 2; }

need() {
  command -v "$1" >/dev/null 2>&1 || { warn "missing dependency: $1"; exit 1; }
}

dc() {
  # The compose file declares `${VAR:?msg}` for JWT_SECRET,
  # GATEWAY_BASE_URL, GATEWAY_TOKEN, KAFKA_BROKERS — docker-compose
  # only reads --env-file (not apps/server/.env automatically). Pass
  # both when they exist so the interpolation succeeds without
  # forcing operators to `export` every variable into their shell.
  local env_args=()
  for f in "${REPO_ROOT}/.env" "${REPO_ROOT}/apps/server/.env" "${REPO_ROOT}/apps/web/.env"; do
    if [[ -f "${f}" ]]; then
      env_args+=(--env-file "$(translate_env_for_docker "${f}")")
    fi
  done
  (cd "${REPO_ROOT}" && docker compose "${env_args[@]}" -f "${COMPOSE_FILE}" "$@")
}

# Take an operator-edited .env file (works with `pnpm dev` on the host)
# and produce a temp copy in which `localhost` / `127.0.0.1` for the
# gateway-facing endpoints is rewritten to the **internal** hostname
# inside the gateway's docker network. The original .env is left
# untouched.
#
#   KAFKA_BROKERS=localhost:9092            → kafka:29092
#   GATEWAY_BASE_URL=http://localhost:8080  → http://eveys-ocpp:8080
#
# The compose file attaches `server` to `eveys-ocpp_default` (declared
# external), so `kafka` and `eveys-ocpp` resolve directly. This bypasses
# the advertised-listener mismatch (`KAFKA_ADVERTISED_LISTENERS=HOST://
# localhost:9092` in the gateway compose) that traps any
# `host.docker.internal:9092` consumer.
#
# Other host-loopback endpoints (ALERTMANAGER_URL, PROMETHEUS_URL) keep
# the host-loopback rewrite for setups where those services run on
# the host.
TRANSLATED_ENV_FILES=()
translate_env_for_docker() {
  local src="$1"
  if ! grep -qE '^(KAFKA_BROKERS|GATEWAY_BASE_URL|ALERTMANAGER_URL|PROMETHEUS_URL)=.*(localhost|127\.0\.0\.1)' "${src}" 2>/dev/null; then
    printf '%s' "${src}"
    return
  fi
  local dst
  dst="$(mktemp -t console-updater-env.XXXXXX)"
  TRANSLATED_ENV_FILES+=("${dst}")
  # awk (not sed) — awk's gsub inside a matching action is portable
  # across BSD and GNU userlands; sed's multi-substitute group syntax
  # is not.
  awk '
    /^KAFKA_BROKERS=/ {
      gsub(/localhost:9092/, "kafka:29092")
      gsub(/127\.0\.0\.1:9092/, "kafka:29092")
      gsub(/localhost/, "kafka")
      gsub(/127\.0\.0\.1/, "kafka")
    }
    /^GATEWAY_BASE_URL=/ {
      gsub(/localhost/, "eveys-ocpp")
      gsub(/127\.0\.0\.1/, "eveys-ocpp")
    }
    /^(ALERTMANAGER_URL|PROMETHEUS_URL)=/ {
      gsub(/localhost/, "host.docker.internal")
      gsub(/127\.0\.0\.1/, "host.docker.internal")
    }
    { print }
  ' "${src}" > "${dst}"
  warn "$(basename "${src}"): localhost rewritten for the gateway docker network: KAFKA_BROKERS->kafka:29092, GATEWAY_BASE_URL->http://eveys-ocpp:8080 (your .env stays untouched for the host-side pnpm dev flow)."
  printf '%s' "${dst}"
}

cleanup_translated_envs() {
  for f in "${TRANSLATED_ENV_FILES[@]:-}"; do
    if [[ -n "${f}" && -f "${f}" ]]; then
      rm -f "${f}"
    fi
  done
  # Explicit success — the trap fires under `set -e` at EXIT, and a
  # falsy `&&` chain in the loop body (e.g. an empty array) would
  # otherwise propagate as the script's exit code.
  return 0
}
trap cleanup_translated_envs EXIT

# Read EVEYS_ENV from shell env, falling back to repo-root .env. Same
# pattern the gateway Makefile uses for its production gate.
read_eveys_env() {
  if [[ -n "${EVEYS_ENV:-}" ]]; then
    printf '%s' "${EVEYS_ENV}"
    return
  fi
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    grep -E '^EVEYS_ENV=' "${REPO_ROOT}/.env" 2>/dev/null \
      | head -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"
  fi
}

# ---------- preconditions ---------------------------------------------------

need docker
docker compose version >/dev/null 2>&1 \
  || { warn "missing dependency: docker compose"; exit 1; }
[[ -f "${COMPOSE_FILE}" ]] \
  || { warn "compose file not found: ${COMPOSE_FILE}"; exit 1; }

EVEYS_ENV_RESOLVED="$(read_eveys_env || true)"
if [[ "${EVEYS_ENV_RESOLVED}" = "production" && "${FORCE_PROD:-0}" != "1" ]]; then
  warn "EVEYS_ENV=production detected."
  warn "This script never tears containers down, but it WILL recreate them"
  warn "in place (brief restart). Pass FORCE_PROD=1 to silence this warning."
  warn ""
  read -r -p "Proceed with the Console update? [y/N] " ans
  case "${ans}" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

bold "eveys-console one-shot update"
echo "  repo:    ${REPO_ROOT}"
echo "  compose: ${COMPOSE_FILE}"
echo ""

# ---------- pull ------------------------------------------------------------

if [[ "${DO_PULL}" -eq 1 ]]; then
  if [[ -d "${REPO_ROOT}/.git" ]]; then
    info "git pull --ff-only in ${REPO_ROOT}"
    if ! (cd "${REPO_ROOT}" && git pull --ff-only); then
      warn "git pull failed — continuing with the working tree as-is"
    fi
  else
    warn "${REPO_ROOT} is not a git checkout — skipping pull"
  fi
fi

# ---------- build + recreate ------------------------------------------------

services=()
[[ "${DO_SERVER}" -eq 1 ]] && services+=("server")
[[ "${DO_WEB}" -eq 1 ]] && services+=("web")

if [[ ${#services[@]} -eq 0 ]]; then
  warn "nothing to do (both --server-only and --web-only would be needed simultaneously)"
  exit 1
fi

info "building: ${services[*]}"
# Cache-buster digest for the web image build. Vite inlines VITE_*
# env vars at build time; if the operator edits apps/web/.env (or the
# repo-root .env) and runs `make update` again, we need the cache for
# the `pnpm build` layer to invalidate even if the surrounding ARG
# values look identical to BuildKit. Hash whatever env files exist
# and pass the digest as a build arg the Dockerfile consumes — any
# byte change in those files produces a different digest, so the
# build layer reliably re-runs.
if [[ "${DO_WEB}" -eq 1 ]]; then
  # Some hosts ship `sha256sum` (GNU coreutils), others ship `shasum`
  # (Perl-based, from the older BSD userland). Pick whichever is on
  # PATH so this works everywhere.
  if command -v sha256sum >/dev/null 2>&1; then
    _digest_cmd=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    _digest_cmd=(shasum -a 256)
  else
    warn "neither sha256sum nor shasum found; web env cache buster disabled (you may need a manual --no-cache rebuild if VITE_* changes don't take effect)"
    _digest_cmd=()
  fi
  if (( ${#_digest_cmd[@]} > 0 )); then
    # Enumerate first — `cat` on a missing file returns non-zero,
    # and `set -o pipefail` would propagate that and abort the
    # build. Repo-root .env is optional (operators may keep
    # everything in apps/server/.env or apps/web/.env), so a missing
    # file shouldn't kill the cache buster.
    _digest_files=()
    for f in "${REPO_ROOT}/apps/web/.env" "${REPO_ROOT}/.env"; do
      [[ -f "${f}" ]] && _digest_files+=("${f}")
    done
    if (( ${#_digest_files[@]} > 0 )); then
      WEB_ENV_DIGEST="$(cat "${_digest_files[@]}" | "${_digest_cmd[@]}" | awk '{print $1}')"
    else
      # No env files at all — hash an empty string so the arg is
      # still a stable value rather than empty.
      WEB_ENV_DIGEST="$(printf '' | "${_digest_cmd[@]}" | awk '{print $1}')"
    fi
    export WEB_ENV_DIGEST
    info "web env digest: ${WEB_ENV_DIGEST:0:12}…"
  fi
fi
dc build "${services[@]}" \
  || fail "build failed"

info "recreating: ${services[*]}"
dc up -d --force-recreate "${services[@]}" \
  || fail "recreate failed"

info "waiting for server health (best-effort, 30s)"
# The runtime image is distroless (no shell, no curl, no wget). The
# only binary on PATH is node. Use it to call /api/healthz; this also
# matches the path the compose healthcheck uses since the /api prefix
# is applied to every HTTP route.
if [[ "${DO_SERVER}" -eq 1 ]]; then
  server_id="$(dc ps -q server 2>/dev/null || true)"
  if [[ -n "${server_id}" ]]; then
    healthy=0
    for _ in $(seq 1 15); do
      if docker exec "${server_id}" \
           /nodejs/bin/node -e "fetch('http://127.0.0.1:8090/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
           >/dev/null 2>&1; then
        healthy=1; break
      fi
      sleep 2
    done
    if [[ "${healthy}" -eq 1 ]]; then
      info "server reports healthy"
    else
      warn "server did not report /api/healthz within 30s — check 'docker logs eveys-console-server'"
    fi
  fi
fi

# ---------- done ------------------------------------------------------------

echo ""
bold "done."
echo "  hard-refresh the browser (Cmd-Shift-R) to pick up the new web bundle"
