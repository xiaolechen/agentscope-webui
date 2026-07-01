"""webui-specific Redis data layer — model configs, MCP lib, Skill lib, schedule proxy."""
import asyncio, json, httpx, os, re, shlex, shutil
from typing import Literal, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from auth_router import UserInDB, admin_required, current_user, _r

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
    transport: Literal["stdio", "sse", "streamable-http"]
    command: str = ""
    args: list[str] = []
    url: str = ""
    is_stateful: bool = True
    is_enabled: bool = True
    # Authentication — applies to remote transports (sse/streamable-http).
    # Mirrors the Swift MCPDefinition model. auth_token is a server-side
    # secret (stored in Redis plaintext, same as credential config) and is
    # stripped from GET /mcp-lib responses so it never reaches the browser.
    auth_type: Literal["none", "bearer", "api_key", "oauth"] = "none"
    auth_token: str = ""
    auth_header_name: str = ""  # api_key only; defaults to X-API-Key

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

    def auth_headers(self) -> Optional[dict[str, str]]:
        """Return the HTTP headers implied by auth_type/auth_token, or None.

        Logic mirrors Swift ``MCPDefinition.authHeaders``:
        - none / empty token  → None
        - bearer / oauth      → ``Authorization: Bearer <token>``
        - api_key             → ``<headerName|X-API-Key>: <token>``
        """
        if not self.auth_token or self.auth_type == "none":
            return None
        if self.auth_type in ("bearer", "oauth"):
            return {"Authorization": f"Bearer {self.auth_token}"}
        if self.auth_type == "api_key":
            header = self.auth_header_name.strip() or "X-API-Key"
            return {header: self.auth_token}
        return None


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


# ── Access control ────────────────────────────────────────────────────────────

async def require_agent_access(
    agent_id: str,
    user: UserInDB = Depends(current_user),
) -> UserInDB:
    """Verify the calling user owns the agent (admin bypasses).

    agentscope uses a shared `x-user-id: webui` namespace, so webui's RBAC
    layer must enforce agent ownership here. Without this check, any
    authenticated user could read or overwrite any other user's agent
    model/MCP/skill config (horizontal privilege escalation).
    """
    if user.role == "admin":
        return user
    if agent_id not in user.bound_agent_ids:
        raise HTTPException(403, f"No access to agent '{agent_id}'")
    return user


# ── Config namespace ──────────────────────────────────────────────────────────
#
# The MCP library, skill-dirs, and skill-disabled sets are keyed by a config
# "owner". Admins share one namespace (`"admin"`) so a second admin sees the
# MCPs and skill paths the first admin registered — admins manage one shared
# library. Non-admin users keep their own namespace (`user.id`) for isolation.
# Agent-bound config (agent-mcps/agent-skills) is keyed by agent_id, not owner,
# so it is shared across users regardless of role (gated by require_agent_access).

def _config_owner(user: UserInDB) -> str:
    return "admin" if user.role == "admin" else user.id


def migrate_admin_shared_namespace() -> None:
    """One-time, idempotent migration: merge each admin's per-user MCP lib,
    skill-dirs, and skill-disabled sets into the shared ``admin`` namespace,
    then delete the old per-user keys.

    Before this, MCP/skill config was keyed by ``user.id``, so a second admin
    saw an empty library. After migration all admins share
    ``webui:config:*:admin``. Non-admin keys are left untouched (they keep
    their own namespace). Safe to run on every startup — old keys are deleted
    once merged, so subsequent boots are no-ops.
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
                continue  # the shared key itself
            # only migrate admins' keys; non-admins keep their own namespace
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


# ── Session ownership tracking ────────────────────────────────────────────────

def _session_key(user_id: str) -> str:
    return f"webui:user-sessions:{user_id}"


@router.post("/session-track")
async def track_session(body: dict, user: UserInDB = Depends(current_user)):
    """Record that this user owns a session. Called right after session creation."""
    session_id = body.get("session_id", "").strip()
    agent_id = body.get("agent_id", "").strip()
    if not (session_id and agent_id):
        raise HTTPException(400, "session_id and agent_id required")

    # Enforce agent ownership (admin bypasses).
    if user.role != "admin" and agent_id not in user.bound_agent_ids:
        raise HTTPException(403, f"No access to agent '{agent_id}'")

    # Verify the session actually exists in agentscope before claiming ownership.
    # NOTE: agentscope uses a shared `x-user-id: webui` namespace, so we cannot
    # prove THIS user created the session — only that it exists for the agent.
    # True ownership attribution requires proxying session creation through webui
    # so the backend can authoritatively record the owner (see C5 in CR notes).
    headers = {"x-user-id": "webui"}
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
        raise HTTPException(
            404, f"Session '{session_id}' not found for agent '{agent_id}'"
        )

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
async def get_agent_model(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_json(f"webui:config:agent-model:{agent_id}") or {}


@router.put("/agent-model/{agent_id}")
async def set_agent_model(agent_id: str, config: ChatModelConfig, _: UserInDB = Depends(require_agent_access)):
    _set_json(f"webui:config:agent-model:{agent_id}", config.model_dump())
    return config


@router.delete("/agent-model/{agent_id}", status_code=204)
async def delete_agent_model(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    _r().delete(f"webui:config:agent-model:{agent_id}")


# ── Per-agent MCP & Skill preferences ────────────────────────────────────────

@router.get("/agent-mcps/{agent_id}")
async def get_agent_mcps(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-mcps:{agent_id}")


@router.put("/agent-mcps/{agent_id}")
async def set_agent_mcps(agent_id: str, body: list = Body(...), _: UserInDB = Depends(require_agent_access)):
    _set_list(f"webui:config:agent-mcps:{agent_id}", body)
    return body


@router.get("/agent-skills/{agent_id}")
async def get_agent_skills(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-skills:{agent_id}")


@router.put("/agent-skills/{agent_id}")
async def set_agent_skills(agent_id: str, body: list = Body(...), _: UserInDB = Depends(require_agent_access)):
    _set_list(f"webui:config:agent-skills:{agent_id}", body)
    return body


# ── Per-agent preset questions ────────────────────────────────────────────────
# Suggested prompts shown in the chat empty-state to guide users. Stored as a
# JSON string array, same pattern as agent-mcps/agent-skills.

@router.get("/agent-questions/{agent_id}")
async def get_agent_questions(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-questions:{agent_id}")


@router.put("/agent-questions/{agent_id}")
async def set_agent_questions(agent_id: str, body: list = Body(...), _: UserInDB = Depends(require_agent_access)):
    # Keep only non-empty, trimmed strings; cap at 5 to avoid UI clutter.
    cleaned = [q.strip() for q in body if isinstance(q, str) and q.strip()][:5]
    _set_list(f"webui:config:agent-questions:{agent_id}", cleaned)
    return cleaned


@router.get("/agent-skills-full/{agent_id}")
async def get_agent_skills_full(agent_id: str, user: UserInDB = Depends(require_agent_access)):
    """Return the agent's bound skills as full skill objects ({name, path, is_enabled}).

    Unlike /skill-lib (which scans the *current user's* registered skill-dirs and
    therefore returns nothing for non-admin users who haven't registered those
    dirs), this resolves names directly from the bound SKILL.md paths — so any
    user with access to the agent can see and invoke its bound skills in the
    chat skill-picker.
    """
    import pathlib
    paths = _get_list(f"webui:config:agent-skills:{agent_id}")
    disabled = set(_get_list(_skill_disabled_key(_config_owner(user))))
    skills = []
    for p in paths:
        sk = pathlib.Path(p)
        skills.append({
            "name": sk.parent.name,
            "path": p,
            "is_enabled": p not in disabled,
        })
    return skills


# ── Session workspace injection ───────────────────────────────────────────────

def _mcpdef_to_client(m: dict) -> dict:
    """Convert webui McpDef (flat) to agentscope MCPClient (nested) format."""
    mcp = McpDef(**m)  # validate + get auth_headers() for free
    if mcp.transport == "stdio":
        return {
            "name": mcp.name,
            "is_stateful": mcp.is_stateful,
            "mcp_config": {
                "type": "stdio_mcp",
                "command": mcp.command,
                "args": mcp.args or None,
            },
        }
    return {
        "name": mcp.name,
        "is_stateful": False,
        "mcp_config": {
            "type": "http_mcp",
            "url": mcp.url,
            "headers": mcp.auth_headers(),
        },
    }


@router.post("/session-workspace")
async def apply_session_workspace(body: dict, request: Request, user: UserInDB = Depends(current_user)):
    """Inject an agent's configured MCPs and Skills into the session workspace.

    Idempotent: skills use SHA-256 dedup internally; MCPs are only added
    if not already present in the workspace.
    """
    agent_id = body.get("agent_id", "").strip()
    session_id = body.get("session_id", "").strip()
    if not agent_id or not session_id:
        raise HTTPException(400, "agent_id and session_id required")

    # Forward the caller's JWT so agentscope's native endpoints (which are now
    # JWT-gated via dependency_overrides) accept the internal workspace calls.
    headers = {"x-user-id": "webui"}
    auth = request.headers.get("Authorization")
    if auth:
        headers["Authorization"] = auth
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
            all_mcps = _get_list(_mcp_key(_config_owner(user)))
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
async def inject_session_skill(body: dict, request: Request, _: UserInDB = Depends(current_user)):
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
    auth = request.headers.get("Authorization")
    if auth:
        headers["Authorization"] = auth
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


# ── Credential custom models ──────────────────────────────────────────────────
# TODO(C4): credentials have no user-binding in the webui layer (unlike agents'
# `bound_agent_ids`), so ownership cannot be enforced here. These endpoints only
# store display metadata (model-name lists), not secrets — but for true multi-
# tenant isolation, add `bound_credential_ids` to UserInDB and gate these the
# same way as the agent-scoped endpoints above.

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


def _require_stdio_admin(mcp: "McpDef", user: UserInDB) -> None:
    """Restrict stdio MCPs to admins.

    stdio MCPs spawn ``command args`` on the backend host as the backend OS
    user — any command runs there. A command allowlist (npx/python/...) does
    NOT prevent RCE (``python -c "import os; os.system(...)"``), so on a
    multi-tenant backend stdio must be admin-only. Remote transports
    (sse/streamable-http) are outbound HTTP and are safe for all users.
    """
    if mcp.transport == "stdio" and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail=(
                "stdio MCPs run commands on the backend host and are "
                "admin-only. Use sse or streamable-http for remote MCPs."
            ),
        )


def _validate_mcp_fields(mcp: "McpDef") -> None:
    """Transport-specific required fields."""
    if mcp.transport == "stdio":
        if not mcp.command.strip():
            raise HTTPException(400, "command is required for stdio transport")
    else:
        if not mcp.url.strip():
            raise HTTPException(400, "url is required for remote transport")


@router.get("/mcp-lib")
async def get_mcp_lib(user: UserInDB = Depends(current_user)):
    # Strip auth_token so the secret never reaches the browser. Saved MCPs are
    # re-tested via /mcp-lib/test/{name} which loads the full def server-side.
    return [{**m, "auth_token": ""} for m in _get_list(_mcp_key(_config_owner(user)))]


@router.post("/mcp-lib")
async def add_mcp(mcp: McpDef, user: UserInDB = Depends(current_user)):
    _require_stdio_admin(mcp, user)
    _validate_mcp_fields(mcp)
    mcps = _get_list(_mcp_key(_config_owner(user)))
    if any(m["name"] == mcp.name for m in mcps):
        raise HTTPException(409, f"MCP '{mcp.name}' already exists")
    mcps.append(mcp.model_dump())
    _set_list(_mcp_key(_config_owner(user)), mcps)
    return mcp


@router.patch("/mcp-lib/{name}")
async def toggle_mcp(name: str, body: dict, user: UserInDB = Depends(current_user)):
    mcps = _get_list(_mcp_key(_config_owner(user)))
    updated = [
        {**m, "is_enabled": body.get("is_enabled", m["is_enabled"])} if m["name"] == name else m
        for m in mcps
    ]
    _set_list(_mcp_key(_config_owner(user)), updated)
    return next((m for m in updated if m["name"] == name), None)


@router.put("/mcp-lib/{name}")
async def update_mcp(name: str, body: McpDef, user: UserInDB = Depends(current_user)):
    """Update an existing MCP's editable fields.

    ``name`` is immutable (it's the Redis key and agent bindings reference it by
    name), so the path name wins over the body. ``is_enabled`` is managed by the
    toggle endpoint and preserved here. ``auth_token`` is a server-side secret:
    if the caller sends an empty token the stored one is kept, so editing other
    fields doesn't force re-entering it; switching auth_type to "none" clears it.
    """
    owner = _config_owner(user)
    mcps = _get_list(_mcp_key(owner))
    raw = next((m for m in mcps if m.get("name") == name), None)
    if not raw:
        raise HTTPException(404, f"MCP '{name}' not found")

    if body.auth_type == "none":
        new_token = ""
    elif body.auth_token:
        new_token = body.auth_token
    else:
        new_token = raw.get("auth_token", "")

    updated = McpDef(
        name=name,
        transport=body.transport,
        command=body.command,
        args=body.args,
        url=body.url,
        is_stateful=body.is_stateful,
        is_enabled=raw.get("is_enabled", True),
        auth_type=body.auth_type,
        auth_token=new_token,
        auth_header_name=body.auth_header_name,
    )
    _require_stdio_admin(updated, user)
    _validate_mcp_fields(updated)
    _set_list(_mcp_key(owner), [updated.model_dump() if m.get("name") == name else m for m in mcps])
    return {**updated.model_dump(), "auth_token": ""}


@router.delete("/mcp-lib/{name}", status_code=204)
async def delete_mcp(name: str, user: UserInDB = Depends(current_user)):
    mcps = _get_list(_mcp_key(_config_owner(user)))
    _set_list(_mcp_key(_config_owner(user)), [m for m in mcps if m["name"] != name])


# ── MCP connection probe (shared by both test endpoints) ──────────────────────

def _unwrap_exc(exc: BaseException) -> BaseException:
    """anyio TaskGroup wraps real errors in ExceptionGroup — dig out the cause."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


async def _probe_mcp(mcp: McpDef) -> list:
    """Connect to the MCP and return its raw tool list. Raises on failure."""
    from agentscope.mcp import MCPClient, StdioMCPConfig, HttpMCPConfig

    if mcp.transport == "stdio":
        client = MCPClient(
            name="mcptest",
            is_stateful=mcp.is_stateful,
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
    # remote: sse / streamable-http (agentscope auto-selects by URL suffix)
    client = MCPClient(
        name="mcptest",
        is_stateful=False,
        mcp_config=HttpMCPConfig(
            type="http_mcp",
            url=mcp.url,
            headers=mcp.auth_headers(),
        ),
    )
    return await client.list_raw_tools()


async def _run_mcp_test(mcp: McpDef) -> dict:
    """Probe an MCP and format the result. Returns 200-style {ok, ...}.

    Failure is a legitimate result, not a server error — both branches return
    a dict so the frontend can render success/failure uniformly.
    """
    timeout = 30.0 if mcp.transport == "stdio" else 15.0
    try:
        tools = await asyncio.wait_for(_probe_mcp(mcp), timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"Timed out after {int(timeout)}s"}
    except Exception as e:
        # anyio wraps probe errors in ExceptionGroup (subclass of Exception);
        # dig out the root cause. Don't catch BaseException — that would swallow
        # KeyboardInterrupt/SystemExit.
        root = _unwrap_exc(e)
        return {"ok": False, "error": f"{type(root).__name__}: {root}"}
    return {
        "ok": True,
        "tool_count": len(tools),
        "tools": [
            {"name": t.name, "description": (t.description or "").strip()}
            for t in tools
        ],
    }


@router.post("/mcp-lib/test")
async def test_mcp(mcp: McpDef, user: UserInDB = Depends(current_user)):
    """Test an unsaved MCP definition (Register dialog's Test button)."""
    _require_stdio_admin(mcp, user)
    return await _run_mcp_test(mcp)


@router.post("/mcp-lib/test/{name}")
async def test_saved_mcp(name: str, user: UserInDB = Depends(current_user)):
    """Re-test a saved MCP by name (list page's expand-row tool listing).

    Loads the full definition — including the server-side auth_token, which is
    stripped from GET /mcp-lib — from Redis, then probes.
    """
    mcps = _get_list(_mcp_key(_config_owner(user)))
    raw = next((m for m in mcps if m.get("name") == name), None)
    if not raw:
        raise HTTPException(404, f"MCP '{name}' not found")
    mcp = McpDef(**raw)
    _require_stdio_admin(mcp, user)
    return await _run_mcp_test(mcp)


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
    return _get_list(_skill_dirs_key(_config_owner(user)))


@router.post("/skill-dirs")
async def add_skill_dir(body: dict, user: UserInDB = Depends(current_user)):
    path = body.get("path", "").strip()
    if not path:
        raise HTTPException(400, "path required")
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    if path not in dirs:
        dirs.append(path)
        _set_list(_skill_dirs_key(owner), dirs)
    return dirs


@router.delete("/skill-dirs")
async def delete_skill_dir(body: dict, user: UserInDB = Depends(current_user)):
    path = body.get("path", "").strip()
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    _set_list(_skill_dirs_key(owner), [d for d in dirs if d != path])
    return {"ok": True}


@router.get("/skill-lib")
async def get_skill_lib(user: UserInDB = Depends(current_user)):
    """Scan registered skill directories and return discovered skills."""
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    disabled = set(_get_list(_skill_disabled_key(owner)))
    return _scan_skills(dirs, disabled)


@router.post("/skill-lib/toggle")
async def toggle_skill(body: dict, user: UserInDB = Depends(current_user)):
    """Enable or disable a specific skill by its SKILL.md path."""
    path = body.get("path", "").strip()
    is_enabled = body.get("is_enabled", True)
    if not path:
        raise HTTPException(400, "path required")
    owner = _config_owner(user)
    disabled = set(_get_list(_skill_disabled_key(owner)))
    if is_enabled:
        disabled.discard(path)   # removing from disabled = enabling
    else:
        disabled.add(path)       # adding to disabled = disabling
    _set_list(_skill_disabled_key(owner), list(disabled))
    return {"path": path, "is_enabled": is_enabled}


# ── Skill install via `npx skills add` (admin-only) ──────────────────────────

# Tokens that indicate shell metacharacter injection — the parsed command must
# only ever be an `npx skills add ...` invocation, so any of these → reject.
_SKILL_INSTALL_FORBIDDEN = set(";|&$`()<>{}\n\r")
_SKILL_INSTALL_ALLOWED_FLAGS = {"--skill", "--force"}


def _parse_skill_install_command(raw: str) -> list[str]:
    """Parse a user-typed `npx skills add <url> --skill <name> [--force]`.

    Returns a sanitized argv list. Never executes the raw string — extracts the
    url + skill name and rebuilds a controlled command, rejecting shell
    metacharacters and non-whitelisted flags. Raises HTTPException(400) on any
    deviation.
    """
    if not raw or not raw.strip():
        raise HTTPException(400, "command is required")
    for ch in _SKILL_INSTALL_FORBIDDEN:
        if ch in raw:
            raise HTTPException(
                400,
                f"command contains forbidden character {ch!r}; "
                "only `npx skills add <url> --skill <name> [--force]` is supported.",
            )
    try:
        tokens = shlex.split(raw)
    except ValueError as e:
        raise HTTPException(400, f"could not parse command: {e}")

    if len(tokens) < 4 or tokens[0] != "npx" or tokens[1] != "skills" or tokens[2] != "add":
        raise HTTPException(
            400,
            "command must start with `npx skills add <url> --skill <name>`.",
        )

    url: Optional[str] = None
    skill_name: Optional[str] = None
    force = False
    i = 3
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--skill":
            if i + 1 >= len(tokens):
                raise HTTPException(400, "--skill requires a value")
            skill_name = tokens[i + 1]
            i += 2
        elif tok == "--force":
            force = True
            i += 1
        elif tok.startswith("-"):
            raise HTTPException(400, f"unsupported flag {tok!r}")
        else:
            if url is not None:
                raise HTTPException(400, "only one source URL is allowed")
            url = tok
            i += 1

    if not url or not skill_name:
        raise HTTPException(400, "url and --skill <name> are required")

    cmd = ["npx", "--yes", "skills", "add", url, "--skill", skill_name]
    if force:
        cmd.append("--force")
    return cmd


def _ensure_skill_dir_registered(owner: str, dir_path: str) -> None:
    """Register a directory as a skill-dir for the config owner if not already present.

    Used after install so that wherever the `skills` CLI lands a skill under the
    target dir, its containing skill-dir is scanned by `_scan_skills`.
    """
    dirs = _get_list(_skill_dirs_key(owner))
    if dir_path not in dirs:
        dirs.append(dir_path)
        _set_list(_skill_dirs_key(owner), dirs)


@router.post("/skill-lib/install")
async def install_skill(body: dict, user: UserInDB = Depends(admin_required)):
    """Install a skill via `npx skills add` into a registered skill-dir.

    Admin-only: npx runs the `skills` package on the backend host and the skill
    content is written to shared disk + injected into LLM prompts (cross-tenant
    prompt-injection / SSRF surface). The command is parsed and rebuilt — the
    user's raw string is never executed — so only `npx skills add <url>
    --skill <name> [--force]` is honored.
    """
    import pathlib

    target_dir = (body.get("target_dir") or "").strip()
    command = body.get("command") or ""

    # target_dir must be one of the user's registered skill-dirs.
    owner = _config_owner(user)
    registered = _get_list(_skill_dirs_key(owner))
    if not target_dir:
        raise HTTPException(400, "target_dir is required")
    if target_dir not in registered:
        raise HTTPException(
            403,
            "target_dir must be one of your registered skill directories "
            "(configure them in Settings).",
        )
    target_path = pathlib.Path(target_dir)
    if not target_path.is_dir():
        raise HTTPException(400, f"target_dir does not exist: {target_dir}")

    cmd = _parse_skill_install_command(command)

    if not shutil.which("npx"):
        raise HTTPException(400, "npx not found on the backend host")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=target_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        proc.kill()  # type: ignore[union-attr]
        return {
            "ok": False,
            "error": "Timed out after 120s",
            "stdout": "",
            "stderr": "",
            "skills": [],
        }
    except FileNotFoundError:
        return {
            "ok": False,
            "error": "npx not found on the backend host",
            "stdout": "",
            "stderr": "",
            "skills": [],
        }

    stdout_s = stdout.decode("utf-8", errors="replace")
    stderr_s = stderr.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        tail = stderr_s.strip()[-400:] or stdout_s.strip()[-400:]
        return {
            "ok": False,
            "error": f"npx exited {proc.returncode}: {tail}",
            "stdout": stdout_s,
            "stderr": stderr_s,
            "skills": [],
        }

    # Discover SKILL.md files created under target_dir (depth-limited) and
    # ensure each skill's containing dir is registered so _scan_skills finds it.
    discovered: list[dict] = []
    for skill_file in target_path.glob("**/SKILL.md"):
        # Skip nested .git / node_modules that the CLI may have checked out.
        parts = skill_file.relative_to(target_path).parts
        if any(seg in {".git", "node_modules"} for seg in parts):
            continue
        skill_dir = skill_file.parent  # dir containing SKILL.md
        scan_dir = str(skill_dir.parent)  # dir _scan_skills iterates
        _ensure_skill_dir_registered(owner, scan_dir)
        discovered.append({"name": skill_dir.name, "path": str(skill_file)})

    return {
        "ok": True,
        "stdout": stdout_s,
        "stderr": stderr_s,
        "skills": discovered,
    }


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
