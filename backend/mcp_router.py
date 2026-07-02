"""MCP library — registration, CRUD, enable/disable, and connection testing."""
import asyncio, logging, re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from auth_router import UserInDB, current_user
from webui_helpers import _config_owner, _get_list, _set_list, _mcp_key, PRODUCTION_MODE

logger = logging.getLogger(__name__)

# MCP names are embedded into LLM tool names as `mcp__{name}__{tool}`.
# Providers restrict tool names to [a-zA-Z0-9_-]+, so we enforce the same
# constraint at save time to avoid silent failures during workspace injection.
_MCP_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

router = APIRouter(prefix="/webui", tags=["webui"])


# ── Model ─────────────────────────────────────────────────────────────────────

class McpDef(BaseModel):
    name: str
    transport: Literal["stdio", "sse", "streamable-http"]
    command: str = ""
    args: list[str] = []
    url: str = ""
    is_stateful: bool = True
    is_enabled: bool = True
    # auth_token is a server-side secret (stored in Redis, same level as
    # credentials) and is stripped from GET /mcp-lib so it never reaches
    # the browser. Re-tested via /mcp-lib/test/{name} which loads it server-side.
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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_stdio_admin(mcp: McpDef, user: UserInDB) -> None:
    """Restrict stdio MCPs to admins.

    stdio MCPs spawn ``command args`` on the backend host as the OS user running
    the backend — any command executes there. A command allowlist (npx/python/…)
    does NOT prevent RCE (e.g. ``python -c "import os; os.system(…)"``), so on a
    multi-tenant deployment stdio must be admin-only. Remote transports
    (sse/streamable-http) are outbound HTTP calls and are safe for all users.
    """
    if mcp.transport == "stdio" and user.role != "admin":
        raise HTTPException(
            status_code=403,
            detail=(
                "stdio MCPs run commands on the backend host and are "
                "admin-only. Use sse or streamable-http for remote MCPs."
            ),
        )


def _validate_mcp_fields(mcp: McpDef) -> None:
    """Transport-specific required-field checks."""
    if mcp.transport == "stdio":
        if not mcp.command.strip():
            raise HTTPException(400, "command is required for stdio transport")
    else:
        if not mcp.url.strip():
            raise HTTPException(400, "url is required for remote transport")


def _mcpdef_to_client(m: dict) -> dict:
    """Convert a webui McpDef (flat dict) to agentscope MCPClient (nested) format."""
    mcp = McpDef(**m)
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
        "is_stateful": mcp.is_stateful,
        "mcp_config": {
            "type": "http_mcp",
            "url": mcp.url,
            "headers": mcp.auth_headers(),
        },
    }


# ── MCP connection probe ──────────────────────────────────────────────────────

def _unwrap_exc(exc: BaseException) -> BaseException:
    """anyio TaskGroup wraps real errors in ExceptionGroup — dig out the cause."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


async def _probe_mcp(mcp: McpDef) -> list:
    """Connect to the MCP server and return its raw tool list. Raises on failure."""
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
    """Probe an MCP and format the result for the frontend.

    Failure is a legitimate result, not a server error — both branches return
    a dict so the frontend can render success/failure uniformly without special-
    casing HTTP status codes.
    """
    timeout = 30.0 if mcp.transport == "stdio" else 15.0
    try:
        tools = await asyncio.wait_for(_probe_mcp(mcp), timeout=timeout)
    except asyncio.TimeoutError:
        logger.info("MCP probe timeout: name=%s transport=%s timeout=%ds",
                    mcp.name, mcp.transport, int(timeout))
        return {"ok": False, "error": f"Timed out after {int(timeout)}s"}
    except Exception as e:
        # anyio wraps probe errors in ExceptionGroup; dig out the root cause.
        # Don't catch BaseException — that would swallow KeyboardInterrupt.
        root = _unwrap_exc(e)
        logger.info("MCP probe failed: name=%s transport=%s error=%s",
                    mcp.name, mcp.transport, root)
        return {"ok": False, "error": f"{type(root).__name__}: {root}"}
    return {
        "ok": True,
        "tool_count": len(tools),
        "tools": [
            {"name": t.name, "description": (t.description or "").strip()}
            for t in tools
        ],
    }


# ── CRUD endpoints ────────────────────────────────────────────────────────────

@router.get("/mcp-lib")
async def get_mcp_lib(user: UserInDB = Depends(current_user)):
    # Strip auth_token so the secret never reaches the browser.
    return [{**m, "auth_token": ""} for m in _get_list(_mcp_key(_config_owner(user)))]


@router.post("/mcp-lib")
async def add_mcp(mcp: McpDef, user: UserInDB = Depends(current_user)):
    _require_stdio_admin(mcp, user)
    _validate_mcp_fields(mcp)
    if PRODUCTION_MODE and mcp.transport == "stdio":
        raise HTTPException(
            403,
            "PRODUCTION_MODE is enabled: stdio MCP registration is not allowed. "
            "Use sse or streamable-http transport instead.",
        )
    owner = _config_owner(user)
    mcps = _get_list(_mcp_key(owner))
    if any(m["name"] == mcp.name for m in mcps):
        raise HTTPException(409, f"MCP '{mcp.name}' already exists")
    mcps.append(mcp.model_dump())
    _set_list(_mcp_key(owner), mcps)
    return mcp


@router.patch("/mcp-lib/{name}")
async def toggle_mcp(name: str, body: dict, user: UserInDB = Depends(current_user)):
    owner = _config_owner(user)
    mcps = _get_list(_mcp_key(owner))
    if not any(m.get("name") == name for m in mcps):
        raise HTTPException(404, f"MCP '{name}' not found")
    updated = [
        {**m, "is_enabled": body.get("is_enabled", m["is_enabled"])} if m["name"] == name else m
        for m in mcps
    ]
    _set_list(_mcp_key(owner), updated)
    return next(m for m in updated if m["name"] == name)


@router.put("/mcp-lib/{name}")
async def update_mcp(name: str, body: McpDef, user: UserInDB = Depends(current_user)):
    """Update an existing MCP's editable fields.

    ``name`` is immutable (agent bindings reference it by name), so the path
    parameter wins. ``is_enabled`` is owned by the toggle endpoint and is
    preserved here. ``auth_token`` is kept when the caller sends an empty
    string; switching ``auth_type`` to "none" clears it.
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
    owner = _config_owner(user)
    _set_list(_mcp_key(owner), [m for m in _get_list(_mcp_key(owner)) if m["name"] != name])


# ── Test endpoints ────────────────────────────────────────────────────────────

@router.post("/mcp-lib/test")
async def test_mcp(mcp: McpDef, user: UserInDB = Depends(current_user)):
    """Test an unsaved MCP definition (Register dialog's Test button)."""
    _require_stdio_admin(mcp, user)
    return await _run_mcp_test(mcp)


@router.post("/mcp-lib/test/{name}")
async def test_saved_mcp(name: str, user: UserInDB = Depends(current_user)):
    """Re-test a saved MCP, loading the full definition (including server-side
    auth_token) from Redis — the token is never included in GET /mcp-lib."""
    mcps = _get_list(_mcp_key(_config_owner(user)))
    raw = next((m for m in mcps if m.get("name") == name), None)
    if not raw:
        raise HTTPException(404, f"MCP '{name}' not found")
    mcp = McpDef(**raw)
    _require_stdio_admin(mcp, user)
    return await _run_mcp_test(mcp)
