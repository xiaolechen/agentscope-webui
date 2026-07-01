#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/common.sh"

LOG_DATE=$(date +%Y-%m-%d)
BACKEND_LOG="logs/backend/backend.log"
BACKEND_CONSOLE="logs/backend/backend-console-${LOG_DATE}.log"
FRONTEND_LOG="logs/frontend/frontend-${LOG_DATE}.log"

echo "Following logs (Ctrl+C to stop tailing, services keep running):"
echo "  $BACKEND_LOG"
echo "  $BACKEND_CONSOLE"
echo "  $FRONTEND_LOG"
echo ""

tail -f \
    "$BACKEND_LOG" \
    "$BACKEND_CONSOLE" \
    "$FRONTEND_LOG" \
    2>/dev/null
