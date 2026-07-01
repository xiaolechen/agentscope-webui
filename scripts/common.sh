#!/bin/bash
# scripts/common.sh — shared helpers for setup.sh / start.sh / stop.sh / logs.sh
# Source this file from project-root scripts:
#   source "$SCRIPT_DIR/scripts/common.sh"

# Guard against double-sourcing
[[ -n "${_COMMON_SH_LOADED:-}" ]] && return 0
_COMMON_SH_LOADED=1

# ── Project root ──────────────────────────────────────────────────────────────
# SCRIPT_DIR must be set by the caller before sourcing this file.
PROJECT_ROOT="${SCRIPT_DIR:?SCRIPT_DIR must be set before sourcing common.sh}"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "  $*"; }

# ── Load .env ─────────────────────────────────────────────────────────────────
# Loads environment variables from .env if it exists.
# Sets port defaults that start.sh and stop.sh both need.
load_env() {
    if [ -f "$PROJECT_ROOT/.env" ]; then
        # shellcheck disable=SC1091
        source "$PROJECT_ROOT/.env"
    else
        warn ".env not found — using defaults (run 'bash setup.sh' to initialize)"
    fi

    BACKEND_PORT="${BACKEND_PORT:-8000}"
    FRONTEND_PORT="${FRONTEND_PORT:-5173}"
}

# ── Python path ───────────────────────────────────────────────────────────────
PYTHON="${PROJECT_ROOT}/.venv/bin/python"

# ── PID file ──────────────────────────────────────────────────────────────────
PID_FILE="$PROJECT_ROOT/.pids"

# ── Port helpers (macOS + Linux) ──────────────────────────────────────────────
# lsof is standard on macOS but not always installed on minimal Linux.
# fuser (from psmisc) is common on Linux but absent on macOS.
# Try lsof first, fall back to fuser.
pids_on_port() {
    local port=$1
    if command -v lsof &>/dev/null; then
        lsof -ti ":${port}" 2>/dev/null || true
    elif command -v fuser &>/dev/null; then
        fuser "${port}/tcp" 2>/dev/null || true
    fi
}

kill_port() {
    local port=$1
    local pids
    pids=$(pids_on_port "$port")
    if [ -n "$pids" ]; then
        warn "Port $port in use (PID $pids) — killing..."
        kill $pids 2>/dev/null || true
        sleep 0.5
        pids=$(pids_on_port "$port")
        [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    fi
}
