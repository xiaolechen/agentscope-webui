#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.pids"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; }

PORTS="8000 5173"

port_label() {
    case "$1" in
        8000) echo "Backend API :8000" ;;
        5173) echo "Frontend :5173" ;;
        *)    echo "Service :$1" ;;
    esac
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
    # lsof works on macOS + Linux; fuser's `port/tcp` syntax is Linux-only.
    pids=$(lsof -ti ":${port}" 2>/dev/null || true)
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
