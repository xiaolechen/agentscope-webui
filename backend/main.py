# -*- coding: utf-8 -*-
"""AgentScope Web UI — backend entry point.

Starts the same AgentScope API as ../agentscope-app/main.py and adds:
  - /auth/*   JWT login and /me
  - /users/*  Admin-only user CRUD with agent binding
  - /logs/*   Log file viewer
"""
import base64
import json as _json
import logging
import os
import pathlib
import sys
import time
from logging.handlers import TimedRotatingFileHandler
from dotenv import load_dotenv

# ── Paths ─────────────────────────────────────────────────────────────────────
# This file lives at <project_root>/backend/main.py
_BACKEND_DIR = pathlib.Path(__file__).parent
_ROOT = _BACKEND_DIR.parent

# Allow bare imports of sibling router modules (auth_router, users_router, …)
sys.path.insert(0, str(_BACKEND_DIR))

load_dotenv(_ROOT / ".env")

# ── Logging ───────────────────────────────────────────────────────────────────
_LOG_DIR = _ROOT / "logs" / "backend"
os.makedirs(_LOG_DIR, exist_ok=True)

_fh = TimedRotatingFileHandler(
    _LOG_DIR / "backend.log",
    when="midnight",
    interval=1,
    backupCount=30,
    encoding="utf-8",
)
_fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-8s %(name)s: %(message)s"))
logging.basicConfig(level=logging.INFO, handlers=[logging.StreamHandler(), _fh])
# Disable propagation to root before adding the file handler explicitly — without
# this, each uvicorn record would propagate to root (which already holds _fh) and
# then be written a second time by the explicit addHandler below.
for _n in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    lg = logging.getLogger(_n)
    lg.propagate = False
    lg.addHandler(_fh)
    lg.addHandler(logging.StreamHandler())

_req_logger = logging.getLogger("request")

# ── AgentScope app ────────────────────────────────────────────────────────────
import uvicorn
from fastapi import Depends
from fastapi.middleware import Middleware
from fastapi.middleware.cors import CORSMiddleware

from agentscope.app import create_app, SubAgentTemplate
from agentscope.app.deps import get_current_user_id
from agentscope.app.message_bus import RedisMessageBus
from agentscope.app.storage import RedisStorage
from agentscope.app.workspace_manager import LocalWorkspaceManager
from agentscope.permission import PermissionContext, PermissionMode

app = create_app(
    storage=RedisStorage(
        host=os.getenv("REDIS_HOST", "localhost"),
        port=int(os.getenv("REDIS_PORT", "6379")),
    ),
    message_bus=RedisMessageBus(
        host=os.getenv("REDIS_HOST", "localhost"),
        port=int(os.getenv("REDIS_PORT", "6379")),
    ),
    workspace_manager=LocalWorkspaceManager(
        basedir=str(_ROOT / "workspaces"),
        default_mcps=[],
    ),
    custom_subagent_templates=[
        SubAgentTemplate(
            type="explorer",
            description=(
                "Read-only agents specialized in exploration tasks. "
                "Can read files but cannot modify, create, or delete them."
            ),
            system_prompt_template=(
                "You are {member_name}, an explorer agent in team '{team_name}' "
                "led by {leader_name}.\n\nTeam purpose: {team_description}\n\n"
                "Your role: {member_description}\n\n"
                "You are read-only. Report results via TeamSay."
            ),
            permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
        ),
    ],
    extra_middlewares=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
        ),
    ],
)

# ── Close the unauthenticated-agentscope-endpoint hole (S1) ───────────────────
# agentscope's get_current_user_id only checks that the X-User-ID header is
# non-empty, so /credential/*, /sessions/*, /chat/, /workspace/*, /schedule/*,
# /agent/*, /knowledge-base/* would otherwise accept any caller that spoofs the
# header — exposing every API key in plaintext and allowing session hijacking.
# Replace it app-wide with JWT auth; the override returns the shared "webui"
# namespace so the existing resource model (shared namespace + webui RBAC on
# /webui/*) is preserved. See auth_router.webui_user_id.

# ── Request logging middleware ────────────────────────────────────────────────
from starlette.middleware.base import BaseHTTPMiddleware


class RequestLogMiddleware(BaseHTTPMiddleware):
    """Log every request: method, path, status, duration, and short user ID.

    User ID is decoded from the JWT without verification (just to annotate the
    log line) — actual auth is enforced by the dependency overrides below.
    """
    async def dispatch(self, request, call_next):
        t0 = time.monotonic()
        user = "anonymous"
        try:
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                parts = auth[7:].split(".")
                if len(parts) >= 2:
                    # Decode only the payload — no signature verification needed
                    # for a log annotation; avoid HMAC work on every request.
                    padded = parts[1] + "=" * (-len(parts[1]) % 4)
                    p = _json.loads(base64.b64decode(
                        padded.replace("-", "+").replace("_", "/")
                    ))
                    user = p.get("sub", "anonymous")[:8]
        except Exception as e:
            # Malformed/token-less Authorization header — not an error, just
            # fall back to "anonymous" for the log line. Real auth is enforced
            # by the dependency overrides, not this annotation.
            _req_logger.debug("jwt log-annotation skipped: %s", e)
        response = await call_next(request)
        ms = (time.monotonic() - t0) * 1000
        _req_logger.info(
            "%s %s %d %.0fms user=%s",
            request.method, request.url.path, response.status_code, ms, user,
        )
        return response


app.add_middleware(RequestLogMiddleware)

# ── Auth & Users routers ──────────────────────────────────────────────────────
import auth_router
import users_router
import mcp_router
import skill_router
import schedule_router
import agent_config_router
import session_router
import model_router
import knowledge_base_router
import redis_browser_router
import tenant_router
import webui_helpers

app.dependency_overrides[get_current_user_id] = auth_router.webui_user_id

app.include_router(auth_router.router)
app.include_router(users_router.router)
app.include_router(mcp_router.router)
app.include_router(skill_router.router)
app.include_router(schedule_router.router)
app.include_router(agent_config_router.router)
app.include_router(session_router.router)
app.include_router(model_router.router)
app.include_router(knowledge_base_router.router)
app.include_router(redis_browser_router.router)
app.include_router(tenant_router.router)

# Migrate per-admin MCP/skill config into the shared `admin` namespace so all
# admins see one library. Idempotent — no-op on boots after the first.
webui_helpers.migrate_admin_shared_namespace()

# ── Log viewer endpoint ───────────────────────────────────────────────────────
# Admin-only: backend logs may contain JWT tokens, user IDs, and error stack
# traces — must not be exposed to unauthenticated or non-admin callers.
@app.get("/logs/{source}", dependencies=[Depends(auth_router.admin_required)])
async def get_logs(source: str):
    if source == "service":
        # Use the most recently modified console log — not today's date,
        # because the server may have been started on a previous day.
        candidates = sorted(_LOG_DIR.glob("backend-console-*.log"),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        log_file = candidates[0] if candidates else None
    else:
        log_file = _LOG_DIR / "backend.log"

    if not log_file or not log_file.exists():
        return {"lines": []}
    lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
    return {"lines": lines[-2000:]}

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        # Default to loopback: agentscope native endpoints are now JWT-gated,
        # but exposing the port broadly increases attack surface. Set
        # BACKEND_HOST=0.0.0.0 only behind a reverse proxy that terminates auth.
        host=os.getenv("BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=True,
        reload_dirs=[str(_BACKEND_DIR)],
    )
