# -*- coding: utf-8 -*-
"""AgentScope Web UI — backend entry point.

Starts the same AgentScope API as ../agentscope-app/main.py and adds:
  - /auth/*   JWT login and /me
  - /users/*  Admin-only user CRUD with agent binding
  - /logs/*   Log file viewer
"""
import logging
import os
import pathlib
import sys
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
for _n in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    logging.getLogger(_n).addHandler(_fh)

# ── AgentScope app ────────────────────────────────────────────────────────────
import uvicorn
from fastapi.middleware import Middleware
from fastapi.middleware.cors import CORSMiddleware

from agentscope.app import create_app, SubAgentTemplate
from agentscope.app.message_bus import RedisMessageBus
from agentscope.app.storage import RedisStorage
from agentscope.app.workspace_manager import LocalWorkspaceManager
from agentscope.mcp import MCPClient, HttpMCPConfig
from agentscope.permission import PermissionContext, PermissionMode

# No default MCPs — stateful MCPs (like browser-use via npx) take 60-70s to
# initialize on each new session because npx must download the package.
# Users can add MCPs via the MCP library page and they'll be injected per session.
default_mcps: list[MCPClient] = []

if os.getenv("AMAP_API_KEY"):
    default_mcps.append(
        MCPClient(
            name="amap",
            mcp_config=HttpMCPConfig(
                url=f"https://mcp.amap.com/mcp?key={os.environ['AMAP_API_KEY']}",
            ),
            is_stateful=False,
        )
    )

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
        default_mcps=default_mcps,
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

# ── Auth & Users routers ──────────────────────────────────────────────────────
import auth_router
import users_router
import webui_router
import redis_browser_router

app.include_router(auth_router.router)
app.include_router(users_router.router)
app.include_router(webui_router.router)
app.include_router(redis_browser_router.router)

# ── Log viewer endpoint ───────────────────────────────────────────────────────
@app.get("/logs/{source}")
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
        host="0.0.0.0",
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=True,
        reload_dirs=[str(_BACKEND_DIR)],
    )
