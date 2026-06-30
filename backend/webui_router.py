"""webui-specific Redis data layer — model configs, MCP lib, Skill lib, schedule proxy."""
import asyncio, json, httpx, os, re
from typing import Optional
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, field_validator
from auth_router import UserInDB, current_user, _r

# MCP names get composed into LLM tool names as `mcp__{name}__{tool}`, which
# providers restrict to [a-zA-Z0-9_-]+. Mirror agentscope's MCPClient regex so
# we reject bad names at save time instead of failing later on workspace inject.
_MCP_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

router = APIRouter(prefix="/webui", tags=["webui"])

AGENTSCOPE_BASE = f"http://localhost:{os.getenv('BACKEND_PORT', '8000')}"


# ── Pydantic models ───────────────────────────────────────────────────────────

class ChatModelConfig(BaseModel):
    type: str
    credential_id: str
    model: str
    parameters: dict = {}


class McpDef(BaseModel):
    name: str
    transport: str
    command: str = ""
    args: list[str] = []
    url: str = ""
    is_enabled: bool = True

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        v = v.strip()
        if not _MCP_NAME_RE.fullmatch(v):
            raise ValueError(
                "MCP name must match [a-zA-Z0-9_-]+ (letters, digits, "
                "underscore, hyphen). It is embedded into LLM-facing tool "
                "names, so non-ASCII characters (e.g. Chinese) aren't allowed."
            )
        return v


class SkillDef(BaseModel):
    name: str
    path: str
    is_enabled: bool = True


class CreateScheduleBody(BaseModel):
    name: str
    description: str = ""
    cron_expression: str
    timezone: str = "UTC"
    agent_id: str
    enabled: bool = True
    stateful: bool = False
    permission_mode: str = "dont_ask"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_json(key: str) -> Optional[dict]:
    data = _r().get(key)
    return json.loads(data) if data else None


def _set_json(key: str, value):
    _r().set(key, json.dumps(value))


def _get_list(key: str) -> list:
    data = _r().get(key)
    return json.loads(data) if data else []


def _set_list(key: str, value: list):
    _r().set(key, json.dumps(value))


# ── Session ownership tracking ────────────────────────────────────────────────

def _session_key(user_id: str) -> str:
    return f"webui:user-sessions:{user_id}"


@router.post("/session-track")
async def track_session(body: dict, user: UserInDB = Depends(current_user)):
    """Record that this user owns a session. Called right after session creation."""
    session_id = body.get("session_id", "").strip()
    agent_id = body.get("agent_id", "").strip()
    if session_id and agent_id:
        _r().sadd(_session_key(user.id), f"{agent_id}:{session_id}")
    return {"ok": True}


@router.get("/my-session-ids/{agent_id}")
async def my_session_ids(agent_id: str, user: UserInDB = Depends(current_user)):
    """Return session IDs owned by the calling user for a given agent.
    Admins get {'all': True} — the frontend shows everything."""
    if user.role == "admin":
        return {"all": True}
    owned: set = _r().smembers(_session_key(user.id))
    prefix = f"{agent_id}:"
    ids = [entry.split(":", 1)[1] for entry in owned if entry.startswith(prefix)]
    return {"session_ids": ids}




@router.get("/me/default-model")
async def get_default_model(user: UserInDB = Depends(current_user)):
    return _get_json(f"webui:config:default-model:{user.id}") or {}


@router.put("/me/default-model")
async def set_default_model(config: ChatModelConfig, user: UserInDB = Depends(current_user)):
    _set_json(f"webui:config:default-model:{user.id}", config.model_dump())
    return config


@router.delete("/me/default-model", status_code=204)
async def delete_default_model(user: UserInDB = Depends(current_user)):
    _r().delete(f"webui:config:default-model:{user.id}")


# ── Per-agent model config ────────────────────────────────────────────────────

@router.get("/agent-model/{agent_id}")
async def get_agent_model(agent_id: str, _: UserInDB = Depends(current_user)):
    return _get_json(f"webui:config:agent-model:{agent_id}") or {}


@router.put("/agent-model/{agent_id}")
async def set_agent_model(agent_id: str, config: ChatModelConfig, _: UserInDB = Depends(current_user)):
    _set_json(f"webui:config:agent-model:{agent_id}", config.model_dump())
    return config


@router.delete("/agent-model/{agent_id}", status_code=204)


# ── Per-agent MCP & Skill preferences ────────────────────────────────────────

@router.get("/agent-mcps/{agent_id}")
async def get_agent_mcps(agent_id: str, _: UserInDB = Depends(current_user)):
    return _get_list(f"webui:config:agent-mcps:{agent_id}")


@router.put("/agent-mcps/{agent_id}")
async def set_agent_mcps(agent_id: str, body: list = Body(...), _: UserInDB = Depends(current_user)):
    _set_list(f"webui:config:agent-mcps:{agent_id}", body)
    return body


@router.get("/agent-skills/{agent_id}")
async def get_agent_skills(agent_id: str, _: UserInDB = Depends(current_user)):
    return _get_list(f"webui:config:agent-skills:{agent_id}")


@router.put("/agent-skills/{agent_id}")
async def set_agent_skills(agent_id: str, body: list = Body(...), _: UserInDB = Depends(current_user)):
    _set_list(f"webui:config:agent-skills:{agent_id}", body)
    return body


# ── Session workspace injection ───────────────────────────────────────────────

def _mcpdef_to_client(m: dict) -> dict:
    """Convert webui McpDef (flat) to agentscope MCPClient (nested) format."""
    if m.get("transport") == "stdio":
        return {
            "name": m["name"],
            "is_stateful": True,
            "mcp_config": {
                "type": "stdio_mcp",
                "command": m.get("command", ""),
                "args": m.get("args") or None,
            },
        }
    return {
        "name": m["name"],
        "is_stateful": False,
        "mcp_config": {
            "type": "http_mcp",
            "url": m.get("url", ""),
        },
    }


@router.post("/session-workspace")
async def apply_session_workspace(body: dict, user: UserInDB = Depends(current_user)):
    """Inject an agent's configured MCPs and Skills into the session workspace.

    Idempotent: skills use SHA-256 dedup internally; MCPs are only added
    if not already present in the workspace.
    """
    agent_id = body.get("agent_id", "").strip()
    session_id = body.get("session_id", "").strip()
    if not agent_id or not session_id:
        raise HTTPException(400, "agent_id and session_id required")

    headers = {"x-user-id": "webui"}
    mcps_added = 0
    mcp_errors: list[dict] = []
    skills_added = 0

    async with httpx.AsyncClient(timeout=30) as client:
        # ── MCPs ──────────────────────────────────────────────────────────────
        desired_mcp_names: set = set(_get_list(f"webui:config:agent-mcps:{agent_id}"))

        if desired_mcp_names:
            # Get MCPs already in workspace to avoid duplicates
            ws_resp = await client.get(
                f"{AGENTSCOPE_BASE}/workspace/mcp",
                params={"agent_id": agent_id, "session_id": session_id},
                headers=headers,
            )
            existing_names: set = set()
            if ws_resp.is_success:
                existing_names = {m.get("name") for m in ws_resp.json()}

            # Get full MCP definitions from mcp-lib
            all_mcps = _get_list(f"webui:config:mcp-lib:{user.id}")
            to_add = [m for m in all_mcps
                      if m.get("name") in desired_mcp_names
                      and m.get("name") not in existing_names]

            for m in to_add:
                resp = await client.post(
                    f"{AGENTSCOPE_BASE}/workspace/mcp",
                    params={"agent_id": agent_id, "session_id": session_id},
                    json=_mcpdef_to_client(m),
                    headers=headers,
                )
                if resp.is_success:
                    mcps_added += 1
                else:
                    # Surface the validation/connect error instead of swallowing.
                    detail = resp.text
                    try:
                        body = resp.json()
                        if isinstance(body, dict) and "detail" in body:
                            d = body["detail"]
                            if isinstance(d, list) and d and isinstance(d[0], dict):
                                detail = d[0].get("msg") or str(d[0])
                            else:
                                detail = str(d)
                    except Exception:
                        pass
                    mcp_errors.append({"name": m.get("name", "?"), "error": detail})

        # ── Skills ────────────────────────────────────────────────────────────
        # skill_paths are SKILL.md file paths; workspace API wants the parent dir
        import pathlib
        skill_paths = _get_list(f"webui:config:agent-skills:{agent_id}")
        for skill_path in skill_paths:
            skill_dir = str(pathlib.Path(skill_path).parent)
            resp = await client.post(
                f"{AGENTSCOPE_BASE}/workspace/skill",
                params={"agent_id": agent_id, "session_id": session_id},
                json={"skill_path": skill_dir},
                headers=headers,
            )
            if resp.is_success:
                skills_added += 1

    return {
        "ok": not mcp_errors,
        "mcps_added": mcps_added,
        "mcp_errors": mcp_errors,
        "skills_added": skills_added,
    }


@router.post("/session-skill")
async def inject_session_skill(body: dict, _: UserInDB = Depends(current_user)):
    """Inject a single skill into an active session workspace.

    Used by the chat skill-picker when the user invokes a skill that isn't
    bound to the agent (bound skills are already injected by
    apply_session_workspace). Idempotent: agentscope dedups skills by SHA-256,
    so calling this for an already-present skill is a safe no-op.
    """
    agent_id = body.get("agent_id", "").strip()
    session_id = body.get("session_id", "").strip()
    skill_path = body.get("skill_path", "").strip()
    if not (agent_id and session_id and skill_path):
        raise HTTPException(400, "agent_id, session_id, skill_path required")

    # skill_path is a SKILL.md file path; the workspace API wants the parent dir
    import pathlib
    skill_dir = str(pathlib.Path(skill_path).parent)
    headers = {"x-user-id": "webui"}
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


async def delete_agent_model(agent_id: str, _: UserInDB = Depends(current_user)):
    _r().delete(f"webui:config:agent-model:{agent_id}")


# ── Credential custom models ──────────────────────────────────────────────────

@router.get("/cred-models/{cred_id}")
async def get_cred_models(cred_id: str, _: UserInDB = Depends(current_user)):
    return _get_list(f"webui:config:cred-models:{cred_id}")


@router.post("/cred-models/{cred_id}")
async def add_cred_model(cred_id: str, body: dict, _: UserInDB = Depends(current_user)):
    model_name = body.get("model", "").strip()
    if not model_name:
        raise HTTPException(400, "model name required")
    models = _get_list(f"webui:config:cred-models:{cred_id}")
    if model_name not in models:
        models.append(model_name)
        _set_list(f"webui:config:cred-models:{cred_id}", models)
    return models


@router.delete("/cred-models/{cred_id}/{model_name}", status_code=204)
async def delete_cred_model(cred_id: str, model_name: str, _: UserInDB = Depends(current_user)):
    models = _get_list(f"webui:config:cred-models:{cred_id}")
    _set_list(f"webui:config:cred-models:{cred_id}", [m for m in models if m != model_name])


# ── MCP library ───────────────────────────────────────────────────────────────

def _mcp_key(user_id: str) -> str:
    return f"webui:config:mcp-lib:{user_id}"


@router.get("/mcp-lib")
async def get_mcp_lib(user: UserInDB = Depends(current_user)):
    return _get_list(_mcp_key(user.id))


@router.post("/mcp-lib")
async def add_mcp(mcp: McpDef, user: UserInDB = Depends(current_user)):
    mcps = _get_list(_mcp_key(user.id))
    if any(m["name"] == mcp.name for m in mcps):
        raise HTTPException(409, f"MCP '{mcp.name}' already exists")
    mcps.append(mcp.model_dump())
    _set_list(_mcp_key(user.id), mcps)
    return mcp


@router.patch("/mcp-lib/{name}")
async def toggle_mcp(name: str, body: dict, user: UserInDB = Depends(current_user)):
    mcps = _get_list(_mcp_key(user.id))
    updated = [
        {**m, "is_enabled": body.get("is_enabled", m["is_enabled"])} if m["name"] == name else m
        for m in mcps
    ]
    _set_list(_mcp_key(user.id), updated)
    return next((m for m in updated if m["name"] == name), None)


@router.delete("/mcp-lib/{name}", status_code=204)
async def delete_mcp(name: str, user: UserInDB = Depends(current_user)):
    mcps = _get_list(_mcp_key(user.id))
    _set_list(_mcp_key(user.id), [m for m in mcps if m["name"] != name])


@router.post("/mcp-lib/test")
async def test_mcp(mcp: McpDef, _: UserInDB = Depends(current_user)):
    """Probe an MCP definition: connect and list tools.

    Returns 200 in both success and failure cases — failure is a legitimate
    result, not a server error. Frontend uses this for both the Register
    dialog's Test button and for the list page's expand-row tool listing.
    """
    from agentscope.mcp import MCPClient, StdioMCPConfig, HttpMCPConfig

    is_stdio = mcp.transport == "stdio"
    timeout = 30.0 if is_stdio else 15.0

    async def _probe() -> list:
        if is_stdio:
            client = MCPClient(
                name="mcptest",
                is_stateful=True,
                mcp_config=StdioMCPConfig(
                    type="stdio_mcp",
                    command=mcp.command,
                    args=mcp.args or None,
                ),
            )
            await client.connect()
            try:
                return await client.list_raw_tools()
            finally:
                await client.close(ignore_errors=True)
        else:
            client = MCPClient(
                name="mcptest",
                is_stateful=False,
                mcp_config=HttpMCPConfig(type="http_mcp", url=mcp.url),
            )
            return await client.list_raw_tools()

    def _unwrap(exc: BaseException) -> BaseException:
        """anyio TaskGroup wraps real errors in ExceptionGroup — dig out the cause."""
        while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
            exc = exc.exceptions[0]
        return exc

    try:
        tools = await asyncio.wait_for(_probe(), timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"Timed out after {int(timeout)}s"}
    except BaseException as e:
        root = _unwrap(e)
        return {"ok": False, "error": f"{type(root).__name__}: {root}"}

    return {
        "ok": True,
        "tool_count": len(tools),
        "tools": [
            {"name": t.name, "description": (t.description or "").strip()}
            for t in tools
        ],
    }


# ── Skills — directory-based scanning ────────────────────────────────────────

def _skill_dirs_key(user_id: str) -> str:
    return f"webui:config:skill-dirs:{user_id}"

def _skill_disabled_key(user_id: str) -> str:
    # Stores explicitly DISABLED skill paths — anything NOT in this set is enabled.
    # Default is enabled, so newly discovered skills are on by default.
    return f"webui:config:skill-disabled:{user_id}"

def _scan_skills(dirs: list, disabled: set) -> list:
    """Scan each configured directory for subdirs containing SKILL.md.
    Skills are enabled by default; only paths in `disabled` are off."""
    import pathlib
    skills = []
    for d in dirs:
        p = pathlib.Path(d)
        if not p.is_dir():
            continue
        for subdir in sorted(p.iterdir()):
            if subdir.is_dir():
                skill_file = subdir / "SKILL.md"
                if skill_file.exists():
                    path_str = str(skill_file)
                    skills.append({
                        "name": subdir.name,
                        "path": path_str,
                        "is_enabled": path_str not in disabled,  # enabled by default
                    })
    return skills


@router.get("/skill-dirs")
async def get_skill_dirs(user: UserInDB = Depends(current_user)):
    return _get_list(_skill_dirs_key(user.id))


@router.post("/skill-dirs")
async def add_skill_dir(body: dict, user: UserInDB = Depends(current_user)):
    path = body.get("path", "").strip()
    if not path:
        raise HTTPException(400, "path required")
    dirs = _get_list(_skill_dirs_key(user.id))
    if path not in dirs:
        dirs.append(path)
        _set_list(_skill_dirs_key(user.id), dirs)
    return dirs


@router.delete("/skill-dirs")
async def delete_skill_dir(body: dict, user: UserInDB = Depends(current_user)):
    path = body.get("path", "").strip()
    dirs = _get_list(_skill_dirs_key(user.id))
    _set_list(_skill_dirs_key(user.id), [d for d in dirs if d != path])
    return {"ok": True}


@router.get("/skill-lib")
async def get_skill_lib(user: UserInDB = Depends(current_user)):
    """Scan registered skill directories and return discovered skills."""
    dirs = _get_list(_skill_dirs_key(user.id))
    disabled = set(_get_list(_skill_disabled_key(user.id)))
    return _scan_skills(dirs, disabled)


@router.post("/skill-lib/toggle")
async def toggle_skill(body: dict, user: UserInDB = Depends(current_user)):
    """Enable or disable a specific skill by its SKILL.md path."""
    path = body.get("path", "").strip()
    is_enabled = body.get("is_enabled", True)
    if not path:
        raise HTTPException(400, "path required")
    disabled = set(_get_list(_skill_disabled_key(user.id)))
    if is_enabled:
        disabled.discard(path)   # removing from disabled = enabling
    else:
        disabled.add(path)       # adding to disabled = disabling
    _set_list(_skill_disabled_key(user.id), list(disabled))
    return {"path": path, "is_enabled": is_enabled}


# ── Schedule proxy (auto-injects chat_model_config from agent model) ──────────

@router.post("/schedule")
async def create_schedule(body: CreateScheduleBody, user: UserInDB = Depends(current_user)):
    model_cfg = _get_json(f"webui:config:agent-model:{body.agent_id}")
    if not model_cfg:
        model_cfg = _get_json(f"webui:config:default-model:{user.id}")
    if not model_cfg:
        raise HTTPException(
            400,
            "Agent has no model configured. Please edit the Agent and select a model first."
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

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{AGENTSCOPE_BASE}/schedule/",
            json=payload,
            headers={"x-user-id": "webui"},
            timeout=30,
        )

    if not resp.is_success:
        raise HTTPException(resp.status_code, resp.text)
    return resp.json()


# ── Backend restart (Admin only) ──────────────────────────────────────────────

@router.post("/restart")
async def restart_backend(user: UserInDB = Depends(current_user)):
    """Trigger a uvicorn StatReload by touching main.py. Admin only.

    Sending SIGTERM to the worker causes the entire server to stop.
    Touching a file in reload_dirs is the correct way to trigger a
    graceful worker reload without stopping the reloader process.
    """
    if user.role != "admin":
        raise HTTPException(403, "Admin only")

    async def _touch_main():
        await asyncio.sleep(0.3)   # let response reach the client first
        import pathlib
        pathlib.Path(__file__).touch()

    asyncio.create_task(_touch_main())
    return {"ok": True, "message": "Backend reloading…"}


# ── Schedule run-now proxy ────────────────────────────────────────────────────

@router.post("/schedule/{schedule_id}/run")
async def run_schedule_now(schedule_id: str, _: UserInDB = Depends(current_user)):
    """Look up a schedule and return its prompt + agent for the frontend to run.

    We don't create the session or trigger chat here — doing so on the server
    causes a race where stream events fire before the frontend can connect SSE,
    and the user sees an empty chat. Instead the frontend reuses its normal
    send() flow (which serialises session creation → chat trigger → SSE connect).
    """
    headers = {"x-user-id": "webui"}

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{AGENTSCOPE_BASE}/schedule/", headers=headers)
        if not resp.is_success:
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
