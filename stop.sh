#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/common.sh"
load_env

PORTS="$BACKEND_PORT $FRONTEND_PORT"

port_label() {
    local port=$1
    if [ "$port" = "$BACKEND_PORT" ]; then
        echo "Backend API :${port}"
    elif [ "$port" = "$FRONTEND_PORT" ]; then
        echo "Frontend :${port}"
    else
        echo "Service :${port}"
    fi
}

echo ""
echo "┌──────────────────────────────────────────┐"
echo "│       AgentScope Web UI — Stopping        │"
echo "└──────────────────────────────────────────┘"
echo ""

# ── Kill by PID ───────────────────────────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
    PIDS=$(cat "$PID_FILE")
    idx=0
    for pid in $PIDS; do
        port=$(echo "$PORTS" | cut -d' ' -f$((idx + 1)))
        label=$(port_label "$port")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && ok "Stopped $label (PID $pid)"
        else
            warn "$label (PID $pid) was already stopped"
        fi
        idx=$((idx + 1))
    done
    rm -f "$PID_FILE"
else
    warn "No .pids file — trying port-based cleanup"
fi

# ── Kill any remaining processes on the ports ─────────────────────────────────
echo ""
echo "Checking for leftover processes on ports..."
for port in $PORTS; do
    pids=$(pids_on_port "$port")
    if [ -n "$pids" ]; then
        warn "Port $port still in use (PID $pids) — force killing..."
        kill -9 $pids 2>/dev/null || true
        ok "Port $port cleared"
    else
        ok "Port $port is free"
    fi
done

echo ""
ok "All done."
echo ""
