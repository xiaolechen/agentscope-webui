"""Schedule proxy and backend restart."""
import asyncio, logging, pathlib

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth_router import UserInDB, admin_required, current_user, _r
from webui_helpers import (
    AGENTSCOPE_BASE,
    _get_json,
    _forward_auth_headers,
    _schedule_key,
)

router = APIRouter(prefix="/webui", tags=["webui"])
logger = logging.getLogger(__name__)


class CreateScheduleBody(BaseModel):
    name: str
    description: str = ""
    cron_expression: str
    timezone: str = "UTC"
    agent_id: str
    enabled: bool = True
    stateful: bool = False
    permission_mode: str = "dont_ask"


# ── Schedule proxy ────────────────────────────────────────────────────────────

@router.post("/schedule")
async def create_schedule(
    body: CreateScheduleBody,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Create a schedule, auto-injecting the agent's chat_model_config.

    Forwards the caller's JWT to the agentscope /schedule/ endpoint, which is
    JWT-gated via the dependency override in main.py.
    """
    model_cfg = _get_json(f"webui:config:agent-model:{body.agent_id}")
    if not model_cfg:
        model_cfg = _get_json(f"webui:config:default-model:{user.id}")
    if not model_cfg:
        raise HTTPException(
            400,
            "Agent has no model configured. Please edit the Agent and select a model first.",
        )

    payload = {
        "name": body.name,
        "description": body.description,
        "cron_expression": body.cron_expression,
        "timezone": body.timezone,
        "agent_id": body.agent_id,
        "enabled": body.enabled,
        "stateful": body.stateful,
        "permission_mode": body.permission_mode,
        "chat_model_config": model_cfg,
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{AGENTSCOPE_BASE}/schedule/",
            json=payload,
            headers=_forward_auth_headers(request),
        )

    if not resp.is_success:
        logger.warning("schedule create failed: agent=%s status=%d body=%s",
                       body.agent_id, resp.status_code, resp.text[:200])
        raise HTTPException(resp.status_code, resp.text)
    created = resp.json()
    # Record creator ownership so the schedule list can be scoped per-user
    # (admin=all, tenant_admin=tenant members, member=own). Schedules are
    # creator-owned runtime data, same model as sessions.
    schedule_id = created.get("id") if isinstance(created, dict) else None
    if schedule_id:
        _r().sadd(_schedule_key(user.id), schedule_id)
    else:
        logger.warning(
            "schedule create ok but no id in response — ownership not tracked: "
            "user=%s agent=%s body=%s",
            user.id, body.agent_id, str(created)[:200],
        )
    return created


@router.post("/schedule/{schedule_id}/run")
async def run_schedule_now(
    schedule_id: str,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Look up a schedule and return its prompt + agent for the frontend to run.

    We don't create the session or trigger chat here — doing so on the server
    causes a race where stream events fire before the frontend can connect SSE.
    The frontend reuses its normal send() flow instead.

    Forwards the caller's JWT to the agentscope /schedule/ endpoint. Enforces
    creator-ownership scope: a non-admin may only run a schedule they own (or,
    for tenant_admin, one owned by a member of their tenant).
    """
    headers = _forward_auth_headers(request)

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{AGENTSCOPE_BASE}/schedule/", headers=headers)
        if not resp.is_success:
            logger.warning("fetch schedules failed: status=%d body=%s",
                           resp.status_code, resp.text[:200])
            raise HTTPException(resp.status_code, "Failed to fetch schedules")

        schedules = resp.json().get("schedules", [])
        record = next((s for s in schedules if s.get("id") == schedule_id), None)
        if record is None:
            raise HTTPException(404, f"Schedule {schedule_id!r} not found")

    # Scope check (defense-in-depth — the list endpoint already hides schedules
    # the caller doesn't own, but run-now is callable by id).
    if not _schedule_visible_to(user, schedule_id):
        logger.warning("schedule run denied: user=%s schedule=%s", user.id, schedule_id)
        raise HTTPException(403, "You do not have access to this schedule")

    data = record.get("data", {})
    return {
        "agent_id": record.get("agent_id", ""),
        "prompt": data.get("description") or data.get("name") or "Run schedule",
        "name": data.get("name", ""),
    }


@router.get("/my-schedule-ids")
async def my_schedule_ids(user: UserInDB = Depends(current_user)):
    """Return schedule IDs visible to the caller.

    Schedules are creator-owned (same model as sessions):
    - admin        → ``{'all': True}`` (frontend lists every schedule)
    - tenant_admin / member / legacy → only schedules created by self
    """
    if user.role == "admin":
        return {"all": True}

    # Non-admin users see only their own schedules. Runtime data is personal,
    # not tenant-shared — tenant_admin does not see other members' schedules.
    return {"schedule_ids": list(_r().smembers(_schedule_key(user.id)))}


def _schedule_visible_to(user: UserInDB, schedule_id: str) -> bool:
    """Whether ``user`` may access ``schedule_id`` under creator-ownership rules."""
    if user.role == "admin":
        return True
    return schedule_id in _r().smembers(_schedule_key(user.id))


# ── Backend restart ───────────────────────────────────────────────────────────

@router.post("/restart")
async def restart_backend(user: UserInDB = Depends(admin_required)):
    """Trigger a uvicorn StatReload by touching this file. Admin-only.

    Sending SIGTERM to the worker stops the entire server. Touching a file in
    reload_dirs is the correct way to trigger a graceful worker reload without
    stopping the reloader process.
    """
    logger.info("backend restart triggered: admin=%s", user.username)

    async def _touch_self():
        await asyncio.sleep(0.3)  # let the response reach the client first
        pathlib.Path(__file__).touch()

    asyncio.create_task(_touch_self())
    return {"ok": True, "message": "Backend reloading…"}
