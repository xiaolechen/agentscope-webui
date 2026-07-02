"""Schedule proxy and backend restart."""
import asyncio, logging, pathlib

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth_router import UserInDB, admin_required, current_user
from webui_helpers import AGENTSCOPE_BASE, _get_json, _forward_auth_headers

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
    return resp.json()


@router.post("/schedule/{schedule_id}/run")
async def run_schedule_now(
    schedule_id: str,
    request: Request,
    _: UserInDB = Depends(current_user),
):
    """Look up a schedule and return its prompt + agent for the frontend to run.

    We don't create the session or trigger chat here — doing so on the server
    causes a race where stream events fire before the frontend can connect SSE.
    The frontend reuses its normal send() flow instead.

    Forwards the caller's JWT to the agentscope /schedule/ endpoint.
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

    data = record.get("data", {})
    return {
        "agent_id": record.get("agent_id", ""),
        "prompt": data.get("description") or data.get("name") or "Run schedule",
        "name": data.get("name", ""),
    }


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
