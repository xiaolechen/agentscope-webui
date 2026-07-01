#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/common.sh"
load_env

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

# ── Python dependency preflight ───────────────────────────────────────────────
echo "[prereq] Checking Python dependencies..."
FAILED_MODS=""
for mod in redis fastapi agentscope uvicorn jose passlib; do
    if ! "$PYTHON" -c "import $mod" 2>/dev/null; then
        FAILED_MODS="${FAILED_MODS} ${mod}"
    fi
done
if [ -n "$FAILED_MODS" ]; then
    err "Missing Python modules:${FAILED_MODS}"
    info "Run: bash setup.sh"
    exit 1
fi
ok "Python dependencies OK"

# ── Dirs ──────────────────────────────────────────────────────────────────────
mkdir -p logs/backend logs/frontend
LOG_DATE=$(date +%Y-%m-%d)

> "logs/backend/backend-console-${LOG_DATE}.log"
> "logs/frontend/frontend-${LOG_DATE}.log"

# ── Port cleanup ──────────────────────────────────────────────────────────────
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
        if [ -f "$log_file" ] && grep -qE "Traceback \(most recent|ELIFECYCLE|Cannot find module|ImportError|ModuleNotFoundError|SyntaxError|EADDRINUSE" "$log_file" 2>/dev/null; then
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
