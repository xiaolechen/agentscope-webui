"""Shared utilities for webui router modules.

Centralises Redis helpers, key functions, the AgentScope base URL, the JWT-
forwarding helper, the shared ChatModelConfig model, and the startup migration
so that all router files can import them without circular dependencies.
"""
import json, logging, os
from typing import Literal, Optional

from fastapi import Request
from pydantic import BaseModel

from auth_router import _r  # Redis client factory

logger = logging.getLogger(__name__)

AGENTSCOPE_BASE = f"http://localhost:{os.getenv('BACKEND_PORT', '8000')}"

# Production security — set PRODUCTION_MODE=true to restrict agent Bash tool
# to read-only commands and block stdio MCP injection. Default: off (dev env).
PRODUCTION_MODE: bool = os.getenv("PRODUCTION_MODE", "false").lower() in ("true", "1", "yes")
# PermissionMode applied in production. "explore" = read-only (blocks ip a/curl/etc.);
# "accept_edits" = allows file writes within workspace but not path traversal.
PRODUCTION_PERMISSION_MODE: str = os.getenv("PRODUCTION_PERMISSION_MODE", "explore")

# Per-agent security levels. Each maps to an agentscope PermissionMode.
# Default when unset: "workspace" (accept_edits — workspace-only read/write).
# PRODUCTION_MODE floors any agent that tries to go above "workspace".
SecurityLevel = Literal["strict", "workspace", "standard", "open"]
LEVEL_TO_PERMISSION_MODE: dict[str, str] = {
    "strict":    "explore",       # read-only bash; blocks ip a / curl / rm
    "workspace": "accept_edits",  # workspace-dir read/write; path traversal denied
    "standard":  "default",       # dangerous ops require confirmation
    "open":      "bypass",        # no restrictions; trusted/dev only
}
_DEFAULT_SECURITY_LEVEL: SecurityLevel = "workspace"


def effective_permission_mode(agent_id: str) -> str:
    """Return the agentscope permission_mode string for an agent's session.

    Applies PRODUCTION_MODE floor: if enabled, 'standard' and 'open' are
    clamped to 'workspace' so production agents can never exceed that ceiling.
    """
    raw = _get_json(_agent_security_key(agent_id)) or {}
    level: str = raw.get("level", _DEFAULT_SECURITY_LEVEL)
    if level not in LEVEL_TO_PERMISSION_MODE:
        level = _DEFAULT_SECURITY_LEVEL
    if PRODUCTION_MODE and level in ("open", "standard"):
        level = "workspace"
    return LEVEL_TO_PERMISSION_MODE[level]


# ── Shared Pydantic model ─────────────────────────────────────────────────────

class ChatModelConfig(BaseModel):
    type: str
    credential_id: str
    model: str
    parameters: dict = {}


# ── Redis helpers ─────────────────────────────────────────────────────────────

def _get_json(key: str) -> Optional[dict]:
    try:
        data = _r().get(key)
        return json.loads(data) if data else None
    except Exception as e:
        logger.error("Redis read error key=%s: %s", key, e)
        return None


def _set_json(key: str, value):
    try:
        _r().set(key, json.dumps(value))
    except Exception as e:
        logger.error("Redis write error key=%s: %s", key, e)


def _get_list(key: str) -> list:
    try:
        data = _r().get(key)
        return json.loads(data) if data else []
    except Exception as e:
        logger.error("Redis read error key=%s: %s", key, e)
        return []


def _set_list(key: str, value: list):
    try:
        _r().set(key, json.dumps(value))
    except Exception as e:
        logger.error("Redis write error key=%s: %s", key, e)


# ── Config namespace ──────────────────────────────────────────────────────────

def _config_owner(user) -> str:
    """Admins share one config namespace; non-admins are scoped by user.id."""
    return "admin" if user.role == "admin" else user.id


# ── Redis key helpers ─────────────────────────────────────────────────────────

def _mcp_key(owner: str) -> str:
    return f"webui:config:mcp-lib:{owner}"


def _skill_dirs_key(owner: str) -> str:
    return f"webui:config:skill-dirs:{owner}"


def _skill_disabled_key(owner: str) -> str:
    return f"webui:config:skill-disabled:{owner}"


def _session_key(user_id: str) -> str:
    return f"webui:user-sessions:{user_id}"


def _agent_security_key(agent_id: str) -> str:
    return f"webui:config:agent-security:{agent_id}"


# ── JWT forwarding ────────────────────────────────────────────────────────────

def _forward_auth_headers(request: Request) -> dict:
    """Build agentscope-compatible headers forwarding the caller's JWT.

    All agentscope native endpoints are JWT-gated via the dependency override
    in main.py. Internal httpx calls must forward the incoming Authorization
    header or they will be rejected with 401.
    """
    headers = {"x-user-id": "webui"}
    auth = request.headers.get("Authorization")
    if auth:
        headers["Authorization"] = auth
    return headers


# ── Admin namespace migration ─────────────────────────────────────────────────
#
# The MCP library, skill-dirs, and skill-disabled sets are keyed by a config
# "owner". Admins share one namespace (`"admin"`) so a second admin sees the
# MCPs and skill paths the first admin registered. Non-admin users keep their
# own namespace (`user.id`) for isolation.

def migrate_admin_shared_namespace() -> None:
    """One-time, idempotent migration: merge per-admin MCP/skill config into
    the shared ``admin`` namespace and delete the old per-user keys.

    Safe to run on every startup — old keys are deleted once merged,
    so subsequent boots are no-ops.
    """
    r = _r()
    shared = "admin"
    for kind in ("mcp-lib", "skill-dirs", "skill-disabled"):
        shared_key = f"webui:config:{kind}:{shared}"
        merged = _get_list(shared_key)
        stale: list[str] = []
        for k in r.scan_iter(match=f"webui:config:{kind}:*"):
            owner = k.split(":")[-1]
            if owner == shared:
                continue
            user_data = _get_json(f"webui:user:id:{owner}") or {}
            if user_data.get("role") != "admin":
                continue
            items = _get_list(k)
            if kind == "mcp-lib":
                seen = {m.get("name") for m in merged if isinstance(m, dict)}
                for m in items:
                    if isinstance(m, dict) and m.get("name") not in seen:
                        merged.append(m)
                        seen.add(m.get("name"))
            else:
                seen = set(merged)
                for it in items:
                    if it not in seen:
                        merged.append(it)
                        seen.add(it)
            stale.append(k)
        if stale:
            _set_list(shared_key, merged)
            for k in stale:
                r.delete(k)
