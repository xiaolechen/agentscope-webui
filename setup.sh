#!/bin/bash
# setup.sh — one-time environment setup for agentscope-webui
# Safe to re-run: skips steps already done.
# Run this once on a fresh machine, then use start.sh to launch.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/common.sh"

step() { echo -e "\n$(tput bold 2>/dev/null || true)[$(($STEP_N))] $*$(tput sgr0 2>/dev/null || true)"; STEP_N=$((STEP_N+1)); }
STEP_N=1

echo ""
echo "┌──────────────────────────────────────────┐"
echo "│    AgentScope Web UI — Environment Setup  │"
echo "└──────────────────────────────────────────┘"

# ── OS detection ──────────────────────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif command -v apt-get &>/dev/null; then
    OS="debian"
elif command -v yum &>/dev/null || command -v dnf &>/dev/null; then
    OS="redhat"
else
    OS="linux"
fi
ok "OS: $OS ($OSTYPE)"

# ── Helper: try sudo, warn if unavailable ─────────────────────────────────────
run_sudo() {
    if command -v sudo &>/dev/null; then
        sudo "$@"
    else
        warn "sudo not available, trying without: $*"
        "$@"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Python 3.11+
# ─────────────────────────────────────────────────────────────────────────────
step "Python 3.11+"

PYTHON_CMD=""
for cmd in python3.13 python3.12 python3.11 python3; do
    if command -v "$cmd" &>/dev/null; then
        _maj=$("$cmd" -c "import sys; print(sys.version_info.major)")
        _min=$("$cmd" -c "import sys; print(sys.version_info.minor)")
        if [ "$_maj" -ge 3 ] && [ "$_min" -ge 11 ]; then
            PYTHON_CMD="$cmd"
            ok "Found $("$cmd" --version) at $(command -v "$cmd")"
            break
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    warn "Python 3.11+ not found — attempting install..."
    case "$OS" in
        debian)
            run_sudo apt-get update -q
            run_sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
            PYTHON_CMD="python3.11"
            ;;
        redhat)
            run_sudo yum install -y python3.11 || run_sudo dnf install -y python3.11
            PYTHON_CMD="python3.11"
            ;;
        macos)
            if command -v brew &>/dev/null; then
                brew install python@3.11
                PYTHON_CMD="python3.11"
            else
                err "Homebrew not found. Install Python 3.11 from https://python.org and re-run."
                exit 1
            fi
            ;;
        *)
            err "Cannot auto-install Python on this OS. Please install Python 3.11+ manually."
            exit 1
            ;;
    esac
    ok "Installed: $("$PYTHON_CMD" --version)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. uv (Python package manager)
# ─────────────────────────────────────────────────────────────────────────────
step "uv (Python package manager)"

if ! command -v uv &>/dev/null; then
    warn "uv not found — installing via installer script..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # Add to PATH for this session
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
fi

if ! command -v uv &>/dev/null; then
    err "uv still not found after install. Add ~/.local/bin to PATH and re-run."
    exit 1
fi
ok "uv $(uv --version)"

# ── .env — initialize BEFORE any pip installs so UV_INDEX_URL is available ───
# On first run .env doesn't exist yet; create it now from .env.example.
# JWT_SECRET is generated with /dev/urandom (no Python needed at this stage).
step ".env configuration"

if [ ! -f ".env" ]; then
    # Generate a 64-char hex secret without Python
    JWT_SECRET=$(od -vN 32 -An -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' \
                 || openssl rand -hex 32 2>/dev/null \
                 || cat /proc/sys/kernel/random/uuid 2>/dev/null | tr -d '-')
    sed "s|JWT_SECRET=change-me-to-a-random-64-char-hex-string|JWT_SECRET=${JWT_SECRET}|" .env.example > .env
    ok ".env created from .env.example with random JWT_SECRET"
    warn "Edit .env and set ADMIN_PASSWORD before production use."
else
    ok ".env already exists — not overwritten"
fi

# Load .env so UV_INDEX_URL (and any other vars) are available for all steps
# shellcheck disable=SC1091
source ./.env

# If UV_INDEX_URL not set, probe PyPI; fall back to aliyun mirror on timeout
if [ -z "${UV_INDEX_URL:-}" ]; then
    if ! curl -sf --max-time 5 https://pypi.org/simple/pip/ -o /dev/null 2>/dev/null; then
        warn "PyPI unreachable — auto-enabling aliyun mirror"
        UV_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"
    fi
fi
if [ -n "${UV_INDEX_URL:-}" ]; then
    export UV_INDEX_URL
    ok "PyPI mirror: $UV_INDEX_URL"
fi

# Detect uv TLS flag — renamed from --system-certs to --native-tls in newer uv
if uv pip install --help 2>&1 | grep -q -- "--native-tls"; then
    UV_TLS="--native-tls"
elif uv pip install --help 2>&1 | grep -q -- "--system-certs"; then
    UV_TLS="--system-certs"
else
    UV_TLS=""
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Node.js 20+
# ─────────────────────────────────────────────────────────────────────────────
step "Node.js 20+"

NODE_OK=false
if command -v node &>/dev/null; then
    NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VER" -ge 20 ]; then
        ok "Node.js $(node --version) — npm $(npm --version)"
        NODE_OK=true
    else
        warn "Node.js $(node --version) is too old (need v20+)"
    fi
fi

if [ "$NODE_OK" = false ]; then
    warn "Installing Node.js 20 via NodeSource..."
    case "$OS" in
        debian)
            # NodeSource setup script adds the repo and installs node
            curl -fsSL https://deb.nodesource.com/setup_20.x | run_sudo bash -
            run_sudo apt-get install -y nodejs
            ;;
        redhat)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | run_sudo bash -
            run_sudo yum install -y nodejs || run_sudo dnf install -y nodejs
            ;;
        macos)
            if command -v brew &>/dev/null; then
                brew install node@20
                brew link --force node@20
            else
                err "Install Node.js 20 from https://nodejs.org and re-run."
                exit 1
            fi
            ;;
        *)
            err "Cannot auto-install Node.js on this OS. Install Node.js 20+ from https://nodejs.org"
            exit 1
            ;;
    esac
    ok "Node.js $(node --version) — npm $(npm --version)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Redis
# ─────────────────────────────────────────────────────────────────────────────
step "Redis"

if ! command -v redis-server &>/dev/null; then
    warn "Redis not found — installing..."
    case "$OS" in
        debian)
            run_sudo apt-get install -y redis-server
            ;;
        redhat)
            run_sudo yum install -y redis || run_sudo dnf install -y redis
            ;;
        macos)
            brew install redis
            ;;
        *)
            err "Cannot auto-install Redis on this OS. Install Redis 6+ manually."
            exit 1
            ;;
    esac
fi
ok "Redis $(redis-server --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) installed"

# Start Redis if not already running
if ! redis-cli ping &>/dev/null 2>&1; then
    warn "Redis not running — starting..."
    if [ "$OS" = "macos" ]; then
        brew services start redis 2>/dev/null || redis-server --daemonize yes
    elif systemctl is-active --quiet redis 2>/dev/null || systemctl is-active --quiet redis-server 2>/dev/null; then
        : # already active per systemctl (race)
    else
        # Try systemctl first, fall back to direct daemonize
        run_sudo systemctl start redis 2>/dev/null \
            || run_sudo systemctl start redis-server 2>/dev/null \
            || redis-server --daemonize yes
    fi
    sleep 1
fi

if redis-cli ping &>/dev/null 2>&1; then
    ok "Redis is running"
else
    err "Could not start Redis. Start it manually with: redis-server --daemonize yes"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Python virtual environment
# ─────────────────────────────────────────────────────────────────────────────
step "Python virtual environment (.venv)"

# Look for an existing sibling venv that already has agentscope installed.
# Reusing it avoids downloading hundreds of packages — much faster on slow networks.
SIBLING_VENVS="
${SCRIPT_DIR}/../agentscope-app/.venv
${SCRIPT_DIR}/../agentscope/.venv
"
REUSED_VENV=false

# If .venv exists but agentscope is not importable, it's a stale/empty venv —
# remove it so we can try to copy from a sibling venv instead.
if [ -d ".venv" ] && ! ".venv/bin/python" -c "import agentscope" 2>/dev/null; then
    warn ".venv exists but agentscope is missing — removing stale venv"
    rm -rf .venv
fi

if [ ! -d ".venv" ]; then
    for candidate in $SIBLING_VENVS; do
        if [ -x "${candidate}/bin/python" ] && "${candidate}/bin/python" -c "import agentscope" 2>/dev/null; then
            info "Reusing existing venv at $candidate (agentscope already installed)"
            cp -r "$candidate" .venv
            ok "Copied .venv from $candidate"
            REUSED_VENV=true
            break
        fi
    done
fi

if [ ! -d ".venv" ]; then
    uv venv .venv --python "$PYTHON_CMD"
    ok "Created fresh .venv with $("$PYTHON_CMD" --version)"
else
    [ "$REUSED_VENV" = false ] && ok ".venv already exists"
fi
PYTHON="${SCRIPT_DIR}/.venv/bin/python"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Backend Python dependencies
# ─────────────────────────────────────────────────────────────────────────────
step "Backend Python dependencies"

AGENTSCOPE_LOCAL="${SCRIPT_DIR}/../agentscope"

# If agentscope is already present in .venv (copied from sibling), skip the
# heavy install. Otherwise install from local source or PyPI.
if "$PYTHON" -c "import agentscope" 2>/dev/null; then
    ok "agentscope already in .venv — skipping full install"
    # If local source exists, ensure editable link is up to date
    if [ -d "$AGENTSCOPE_LOCAL" ]; then
        uv pip install -e "${AGENTSCOPE_LOCAL}[full]" --python "$PYTHON" $UV_TLS --no-deps 2>&1 | tail -2
    fi
else
    if [ -d "$AGENTSCOPE_LOCAL" ]; then
        info "Installing agentscope from local source (editable)…"
        info "(This may take a minute on first run)"
        uv pip install -e "${AGENTSCOPE_LOCAL}[full]" --python "$PYTHON" $UV_TLS --upgrade
    else
        info "Installing agentscope from PyPI…"
        info "(This may take a minute on first run)"
        uv pip install "agentscope[full]>=2.0.3" --python "$PYTHON" $UV_TLS --upgrade
    fi
fi

# Read all other deps from pyproject.toml (excludes agentscope, handled above).
# tomllib is in Python stdlib since 3.11 — no extra install needed.
info "Installing remaining deps from backend/pyproject.toml…"
OTHER_DEPS=$("$PYTHON_CMD" - <<'PYEOF'
import tomllib, sys
with open("backend/pyproject.toml", "rb") as f:
    data = tomllib.load(f)
deps = [d for d in data["project"]["dependencies"]
        if not d.lower().startswith("agentscope")]
print("\n".join(deps))
PYEOF
)
if [ -n "$OTHER_DEPS" ]; then
    echo "$OTHER_DEPS" | xargs uv pip install --python "$PYTHON" $UV_TLS
fi

ok "Backend deps installed ($("$PYTHON" --version))"

# ─────────────────────────────────────────────────────────────────────────────
# 7. Frontend Node.js dependencies
# ─────────────────────────────────────────────────────────────────────────────
step "Frontend Node.js dependencies"

# package-lock.json may have been committed with `resolved` URLs pointing to
# an internal registry (registry.anpm.alibaba-inc.com) that's unreachable
# outside that network. npm honors the lock's resolved URLs over the registry
# config, so every tarball fetch ETIMEDOUTs and npm eventually crashes with
# "Exit handler never called!". Rewrite any such URLs to the configured
# (reachable) registry before installing.
LOCK="frontend/package-lock.json"
if [ -f "$LOCK" ] && grep -q 'registry.anpm.alibaba-inc.com' "$LOCK" 2>/dev/null; then
    NPM_REGISTRY=$(npm config get registry 2>/dev/null | sed 's#/\?$##')
    [ -z "$NPM_REGISTRY" ] && NPM_REGISTRY="https://registry.npmmirror.com"
    warn "Rewriting internal registry URLs in $LOCK → $NPM_REGISTRY"
    sed -i.bak "s|https://registry.anpm.alibaba-inc.com|${NPM_REGISTRY}|g" "$LOCK"
    rm -f "${LOCK}.bak"
fi

if [ ! -d "frontend/node_modules" ]; then
    npm install --prefix frontend 2>&1 | tail -5
    ok "frontend/node_modules installed"
else
    # Still run install in case package.json changed
    npm install --prefix frontend 2>&1 | tail -3
    ok "frontend/node_modules up to date"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────┐"
echo "│  Setup complete. Next step:               │"
echo "│                                           │"
echo "│    bash start.sh                          │"
echo "│                                           │"
echo "│  Default login: admin / admin123          │"
echo "│  (set ADMIN_PASSWORD in .env to change)   │"
echo "└──────────────────────────────────────────┘"
echo ""
