"""Session management — ownership tracking and workspace injection."""
import asyncio, logging, pathlib

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth_router import UserInDB, current_user, _r
from webui_helpers import (
    AGENTSCOPE_BASE,
    _config_owner, _get_list,
    _mcp_key, _session_key,
    _forward_auth_headers,
    PRODUCTION_MODE,
    effective_permission_mode,
)
from mcp_router import McpDef, _mcpdef_to_client

router = APIRouter(prefix="/webui", tags=["webui"])
logger = logging.getLogger(__name__)


def _extract_detail(resp: httpx.Response) -> str:
    """Extract a human-readable error string from an httpx response."""
    try:
        parsed = resp.json()
        if isinstance(parsed, dict) and "detail" in parsed:
            d = parsed["detail"]
            if isinstance(d, list) and d and isinstance(d[0], dict):
                return d[0].get("msg") or str(d[0])
            return str(d)
    except Exception:
        pass
    return resp.text


# ── Session ownership tracking ────────────────────────────────────────────────

@router.post("/session-track")
async def track_session(
    body: dict,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Record that this user owns a session. Called right after session creation.

    Forwards the caller's JWT to the agentscope /sessions/ endpoint, which is
    JWT-gated via the dependency override in main.py.
    """
    session_id = body.get("session_id", "").strip()
    agent_id = body.get("agent_id", "").strip()
    if not (session_id and agent_id):
        raise HTTPException(400, "session_id and agent_id required")

    if user.role != "admin" and agent_id not in user.bound_agent_ids:
        raise HTTPException(403, f"No access to agent '{agent_id}'")

    headers = _forward_auth_headers(request)
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{AGENTSCOPE_BASE}/sessions/",
            params={"agent_id": agent_id},
            headers=headers,
        )
    if not resp.is_success:
        raise HTTPException(404, f"Agent '{agent_id}' not found")

    sessions = resp.json().get("sessions", [])
    exists = any((s.get("session") or {}).get("id") == session_id for s in sessions)
    if not exists:
        raise HTTPException(404, f"Session '{session_id}' not found for agent '{agent_id}'")

    _r().sadd(_session_key(user.id), f"{agent_id}:{session_id}")
    return {"ok": True}


@router.get("/my-session-ids/{agent_id}")
async def my_session_ids(agent_id: str, user: UserInDB = Depends(current_user)):
    """Return session IDs owned by the calling user for the given agent.
    Admins receive ``{'all': True}`` — the frontend shows all sessions."""
    if user.role == "admin":
        return {"all": True}
    owned: set = _r().smembers(_session_key(user.id))
    prefix = f"{agent_id}:"
    ids = [entry.split(":", 1)[1] for entry in owned if entry.startswith(prefix)]
    return {"session_ids": ids}


# ── Session workspace injection ───────────────────────────────────────────────

@router.post("/session-workspace")
async def apply_session_workspace(
    body: dict,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Inject an agent's configured MCPs and Skills into the session workspace.

    Idempotent: skills use SHA-256 dedup internally; MCPs are only added
    if not already present in the workspace.

    Forwards the caller's JWT to the agentscope /workspace/* endpoints, which
    are JWT-gated via the dependency override in main.py.
    """
    agent_id = body.get("agent_id", "").strip()
    session_id = body.get("session_id", "").strip()
    if not agent_id or not session_id:
        raise HTTPException(400, "agent_id and session_id required")

    headers = _forward_auth_headers(request)

    async with httpx.AsyncClient(timeout=30) as client:
        # ── MCPs ──────────────────────────────────────────────────────────────
        desired_mcp_names: set = set(_get_list(f"webui:config:agent-mcps:{agent_id}"))
        mcp_errors: list[dict] = []
        mcps_added = 0

        if desired_mcp_names:
            ws_resp = await client.get(
                f"{AGENTSCOPE_BASE}/workspace/mcp",
                params={"agent_id": agent_id, "session_id": session_id},
                headers=headers,
            )
            existing_names: set = set()
            if ws_resp.is_success:
                existing_names = {m.get("name") for m in ws_resp.json()}

            # MCP library lives in the admin namespace; look up directly so
            # non-admin users can still get their agent's admin-curated MCPs.
            all_mcps = _get_list(_mcp_key("admin"))

            if PRODUCTION_MODE:
                skipped_stdio = [
                    m.get("name") for m in all_mcps
                    if isinstance(m, dict)
                    and m.get("transport") == "stdio"
                    and m.get("name") in desired_mcp_names
                ]
                if skipped_stdio:
                    logger.warning(
                        "production-mode: skipped stdio MCPs=%s agent=%s session=%s",
                        skipped_stdio, agent_id, session_id,
                    )

            to_add = [
                m for m in all_mcps
                if isinstance(m, dict)
                and m.get("name") in desired_mcp_names
                and m.get("name") not in existing_names
                and m.get("is_enabled", True)
                and not (PRODUCTION_MODE and m.get("transport") == "stdio")
            ]

            async def _post_mcp(m: dict) -> dict | None:
                resp = await client.post(
                    f"{AGENTSCOPE_BASE}/workspace/mcp",
                    params={"agent_id": agent_id, "session_id": session_id},
                    json=_mcpdef_to_client(m),
                    headers=headers,
                )
                if resp.is_success:
                    return None
                return {"name": m.get("name", "?"), "error": _extract_detail(resp)}

            mcp_results = await asyncio.gather(*[_post_mcp(m) for m in to_add])
            mcp_errors = [r for r in mcp_results if r is not None]
            mcps_added = len(to_add) - len(mcp_errors)

        # ── Skills ────────────────────────────────────────────────────────────
        skill_paths = _get_list(f"webui:config:agent-skills:{agent_id}")

        async def _post_skill(skill_path: str) -> bool:
            skill_dir = str(pathlib.Path(skill_path).parent)
            resp = await client.post(
                f"{AGENTSCOPE_BASE}/workspace/skill",
                params={"agent_id": agent_id, "session_id": session_id},
                json={"skill_path": skill_dir},
                headers=headers,
            )
            if not resp.is_success:
                logger.warning(
                    "skill inject failed: agent=%s session=%s path=%s status=%d body=%s",
                    agent_id, session_id, skill_path, resp.status_code, resp.text[:200],
                )
                return False
            return True

        skill_results = await asyncio.gather(*[_post_skill(p) for p in skill_paths])
        skills_added = sum(1 for r in skill_results if r)

        mode = effective_permission_mode(agent_id)
        pm_resp = await client.patch(
            f"{AGENTSCOPE_BASE}/sessions/{session_id}",
            params={"agent_id": agent_id},
            json={"permission_mode": mode},
            headers=headers,
        )
        if pm_resp.is_success:
            logger.info(
                "security: permission_mode=%s agent=%s session=%s",
                mode, agent_id, session_id,
            )
        else:
            logger.warning(
                "security: failed to set permission_mode=%s agent=%s session=%s status=%d",
                mode, agent_id, session_id, pm_resp.status_code,
            )

    return {
        "ok": not mcp_errors,
        "mcps_added": mcps_added,
        "mcp_errors": mcp_errors,
        "skills_added": skills_added,
    }


@router.post("/session-skill")
async def inject_session_skill(
    body: dict,
    request: Request,
    _: UserInDB = Depends(current_user),
):
    """Inject a single skill into an active session workspace.

    Used by the chat skill-picker when the user invokes a skill that isn't
    bound to the agent. Idempotent: agentscope dedups skills by SHA-256.

    Forwards the caller's JWT to the agentscope /workspace/skill endpoint.
    """
    agent_id = body.get("agent_id", "").strip()
    session_id = body.get("session_id", "").strip()
    skill_path = body.get("skill_path", "").strip()
    if not (agent_id and session_id and skill_path):
        raise HTTPException(400, "agent_id, session_id, skill_path required")

    skill_dir = str(pathlib.Path(skill_path).parent)
    headers = _forward_auth_headers(request)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{AGENTSCOPE_BASE}/workspace/skill",
            params={"agent_id": agent_id, "session_id": session_id},
            json={"skill_path": skill_dir},
            headers=headers,
        )
    if not resp.is_success:
        raise HTTPException(resp.status_code, f"skill inject failed: {resp.text}")
    return {"ok": True}
