#!/usr/bin/env bash
# scripts/doctor.sh — verify prerequisites for eveys-console on any
# supported host (Linux server or Mac workstation).
#
# Mirrors the gateway's scripts/doctor.sh. Checks every tool the
# Console actually needs against a sane minimum version. Exit code 0
# = ready to install; exit code 1 = at least one required tool is
# missing or below the minimum. Optional tools (gh, jq, kafkacat)
# are reported as warnings only.

set -u

# ---- helpers ----------------------------------------------------------------

RED=$(printf '\033[0;31m')
GREEN=$(printf '\033[0;32m')
YELLOW=$(printf '\033[0;33m')
BOLD=$(printf '\033[1m')
RESET=$(printf '\033[0m')

if [ ! -t 1 ]; then
    RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi

required_failures=0
optional_warnings=0

ok()   { printf "  %s✓%s %-12s %s\n" "$GREEN"  "$RESET" "$1" "$2"; }
miss() { printf "  %s✗%s %-12s %s\n" "$RED"    "$RESET" "$1" "$2"; required_failures=$((required_failures + 1)); }
warn() { printf "  %s!%s %-12s %s\n" "$YELLOW" "$RESET" "$1" "$2"; optional_warnings=$((optional_warnings + 1)); }

# `version_ge A B` is true iff A >= B (semver-ordered).
version_ge() {
    [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

check_required() {
    local name="$1" cmd="$2" min="$3" install_hint="$4" version_extractor="$5"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        miss "$name" "missing — install: $install_hint"
        return
    fi
    local actual
    actual=$(eval "$version_extractor" 2>/dev/null) || true
    if [ -z "$actual" ]; then
        warn "$name" "installed but version could not be parsed (continuing)"
        return
    fi
    if version_ge "$actual" "$min"; then
        ok "$name" "$actual (>= $min)"
    else
        miss "$name" "$actual (need >= $min) — upgrade: $install_hint"
    fi
}

check_optional() {
    local name="$1" cmd="$2" install_hint="$3"
    if command -v "$cmd" >/dev/null 2>&1; then
        ok "$name" "$(command -v "$cmd")"
    else
        warn "$name" "missing (optional) — install: $install_hint"
    fi
}

# ---- required tools ---------------------------------------------------------

printf "%sRequired:%s\n" "$BOLD" "$RESET"

# Node — apps/server and apps/web both target 20+. The Dockerfiles
# pin 20.10.0; locally anything >= 20.10.0 is fine.
check_required "node" "node" "20.10.0" \
    "https://nodejs.org/ (any Node 20+ package works on Linux or Mac)" \
    "node --version | sed 's/^v//'"

# Corepack ships with Node 16.10+. We use it to pin pnpm.
check_required "corepack" "corepack" "0.20.0" \
    "ships with Node 16.10+; run 'corepack enable' if missing" \
    "corepack --version"

# pnpm — pinned at 9.15.0 via the lockfile + .npmrc.
check_required "pnpm" "pnpm" "9.15.0" \
    "corepack prepare pnpm@9.15.0 --activate" \
    "pnpm --version"

# Docker — the compose flow + scripts/updater.sh both require it.
# Any Docker Engine 24+ works: Docker Desktop, the Linux server
# packages from docs.docker.com, Rancher Desktop, colima, etc.
check_required "docker" "docker" "24.0.0" \
    "https://docs.docker.com/engine/install/  (any distribution shipping Engine 24+)" \
    "docker --version | sed -E 's/.*version ([0-9.]+).*/\\1/'"

# docker compose (v2 plugin) — `docker-compose` v1 is not supported.
if docker compose version >/dev/null 2>&1; then
    actual=$(docker compose version --short 2>/dev/null || echo "")
    if [ -n "$actual" ] && version_ge "$actual" "2.20.0"; then
        ok "compose" "v$actual (>= v2.20.0)"
    else
        miss "compose" "v${actual:-?} (need >= v2.20.0) — upgrade Docker Engine"
    fi
else
    miss "compose" "missing — install the docker-compose-plugin; check 'docker compose version'"
fi

# git — needed by scripts/updater.sh for `git pull`.
check_required "git" "git" "2.30.0" \
    "https://git-scm.com/downloads" \
    "git --version | sed -E 's/.* ([0-9.]+).*/\\1/'"

# make — used by the Makefile (you're already running it if you got here).
check_required "make" "make" "3.81" \
    "package name is 'make' on Debian/Ubuntu/Fedora/Alpine; ships with the developer command-line tools" \
    "make --version | head -n1 | sed -E 's/.* ([0-9.]+).*/\\1/'"

# ---- optional tools ---------------------------------------------------------

echo ""
printf "%sOptional:%s\n" "$BOLD" "$RESET"

check_optional "gh"        "gh"        "https://cli.github.com/  (PRs from the CLI)"
check_optional "jq"        "jq"        "package name is 'jq'  (poking at /api/* responses)"
check_optional "kafkacat"  "kcat"      "package name is 'kafkacat' or 'kcat'  (inspecting the gateway's Kafka topics)"
check_optional "promtool"  "promtool"  "ships with the Prometheus release tarball  (validating rules locally)"

# ---- summary ----------------------------------------------------------------

echo ""
if [ "$required_failures" -gt 0 ]; then
    printf "%s%d required tool(s) missing or below the minimum.%s\n" \
        "$RED" "$required_failures" "$RESET"
    exit 1
fi

if [ "$optional_warnings" -gt 0 ]; then
    printf "%sAll required tools present.%s %d optional tool(s) not installed.\n" \
        "$GREEN" "$RESET" "$optional_warnings"
else
    printf "%sReady to go.%s\n" "$GREEN" "$RESET"
fi
exit 0
