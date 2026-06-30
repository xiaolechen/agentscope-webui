#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }
info() { echo -e "  $*"; }

# ── Load env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    warn ".env not found — run 'bash setup.sh' first to initialize the environment."
    warn "Falling back to defaults (JWT_SECRET will be random, sessions reset on restart)."
fi
[ -f .env ] && source ./.env

# Reuse local .venv created by setup.sh
PYTHON="${SCRIPT_DIR}/.venv/bin/python"

# ── Ports (override via .env or environment) ──────────────────────────────────
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

echo ""
echo "┌──────────────────────────────────────────┐"
echo "│       AgentScope Web UI — Starting        │"
echo "└──────────────────────────────────────────┘"
echo ""

# ── Redis ─────────────────────────────────────────────────────────────────────
echo "[prereq] Checking Redis..."
if redis-cli ping > /dev/null 2>&1; then
    ok "Redis is running"
else
    err "Redis is not running."
    info "Start it with: redis-server --daemonize yes"
    exit 1
fi

# ── Python venv ───────────────────────────────────────────────────────────────
echo "[prereq] Checking Python environment..."
if [ ! -x "$PYTHON" ]; then
    err ".venv not found. Run: bash setup.sh"
    exit 1
fi
ok "Python $("$PYTHON" --version)"

# ── Dirs ──────────────────────────────────────────────────────────────────────
mkdir -p logs/backend logs/frontend
LOG_DATE=$(date +%Y-%m-%d)
PID_FILE="$SCRIPT_DIR/.pids"

> "logs/backend/backend-console-${LOG_DATE}.log"
> "logs/frontend/frontend-${LOG_DATE}.log"

# ── Port cleanup ──────────────────────────────────────────────────────────────
# Cross-platform: lsof works on macOS + Linux; fuser's `port/tcp` syntax is
# Linux-only and silently no-ops on macOS, leaving stale processes alive.
kill_port() {
    local port=$1
    local pids
    pids=$(lsof -ti ":${port}" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        warn "Port $port in use (PID $pids) — killing..."
        kill $pids 2>/dev/null || true
        sleep 0.5
        # Force-kill anything still hanging on
        pids=$(lsof -ti ":${port}" 2>/dev/null || true)
        [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    fi
}

echo ""
echo "[1/3] Cleaning up ports $BACKEND_PORT / $FRONTEND_PORT..."
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"
ok "Ports cleared"

# ── Wait-for-ready helper ─────────────────────────────────────────────────────
# $1=label  $2=port  $3=log_file  $4=ready_pattern  $5=timeout(s)
wait_for_ready() {
    local label=$1 port=$2 log_file=$3 pattern=$4 timeout=${5:-90}
    local elapsed=0
    printf "      Waiting for %s (:%s)" "$label" "$port"
    while [ $elapsed -lt $timeout ]; do
        if [ -f "$log_file" ] && grep -q "$pattern" "$log_file" 2>/dev/null; then
            echo " (${elapsed}s)"
            return 0
        fi
        if [ -f "$log_file" ] && grep -qE "Traceback \(most recent|ELIFECYCLE|Cannot find module" "$log_file" 2>/dev/null; then
            echo ""
            err "$label crashed during startup"
            return 1
        fi
        printf "."
        sleep 1
        elapsed=$((elapsed + 1))
    done
    echo ""
    err "$label did not become ready within ${timeout}s"
    return 1
}

# ── Backend ───────────────────────────────────────────────────────────────────
echo ""
echo "[2/3] Starting backend (port $BACKEND_PORT)..."
info "Python : $PYTHON"
info "Log    : logs/backend/backend-console-${LOG_DATE}.log"
# Truncate (>) instead of append (>>): wait_for_ready greps this file for
# "Application startup complete" — appending to old logs would match a previous
# successful run and falsely report success.
nohup "$PYTHON" backend/main.py \
    > "logs/backend/backend-console-${LOG_DATE}.log" 2>&1 &
BACKEND_PID=$!

if wait_for_ready "Backend API" "$BACKEND_PORT" \
    "logs/backend/backend-console-${LOG_DATE}.log" \
    "Application startup complete\|Uvicorn running\|started server" 90; then
    ok "Backend is up  →  http://localhost:${BACKEND_PORT}"
else
    err "Backend did not start. Last 20 lines:"
    tail -20 "logs/backend/backend-console-${LOG_DATE}.log" 2>/dev/null | sed 's/^/    /'
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
fi

# ── Frontend ──────────────────────────────────────────────────────────────────
echo ""
echo "[3/3] Starting frontend (port $FRONTEND_PORT)..."
info "Log : logs/frontend/frontend-${LOG_DATE}.log"
# Truncate (>): same reason as backend — avoid false-positive readiness match.
nohup npm run dev --prefix frontend \
    > "logs/frontend/frontend-${LOG_DATE}.log" 2>&1 &
FRONTEND_PID=$!

if wait_for_ready "Frontend" "$FRONTEND_PORT" \
    "logs/frontend/frontend-${LOG_DATE}.log" \
    "Local:.*${FRONTEND_PORT}\|ready in" 60; then
    ok "Frontend is up  →  http://localhost:${FRONTEND_PORT}"
else
    err "Frontend did not start. Last 20 lines:"
    tail -20 "logs/frontend/frontend-${LOG_DATE}.log" 2>/dev/null | sed 's/^/    /'
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
    exit 1
fi

# ── Save PIDs ─────────────────────────────────────────────────────────────────
echo "$BACKEND_PID $FRONTEND_PID" > "$PID_FILE"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────┐"
printf "│  %-40s│\n" "Backend API  : http://localhost:${BACKEND_PORT}"
printf "│  %-40s│\n" "Frontend     : http://localhost:${FRONTEND_PORT}"
printf "│  %-40s│\n" "API Docs     : http://localhost:${BACKEND_PORT}/docs"
echo "├──────────────────────────────────────────┤"
printf "│  %-40s│\n" "PIDs: $BACKEND_PID (api)  $FRONTEND_PID (ui)"
echo "└──────────────────────────────────────────┘"
echo ""
info "Follow logs   : bash logs.sh"
info "Stop all      : bash stop.sh"
info "Default login : admin / admin123"
echo ""
