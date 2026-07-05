"""Per-agent configuration — model, MCP bindings, skill bindings, preset questions, security level."""
import logging, pathlib
from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from auth_router import UserInDB, current_user, _r
from webui_helpers import (
    ChatModelConfig,
    _config_owner, _get_json, _set_json, _get_list, _set_list,
    _skill_disabled_key, _agent_security_key,
    _allowed_mcps, _allowed_skills, user_can_access_agent,
)

router = APIRouter(prefix="/webui", tags=["webui"])
logger = logging.getLogger(__name__)


# ── Access control ────────────────────────────────────────────────────────────

async def require_agent_access(
    agent_id: str,
    user: UserInDB = Depends(current_user),
) -> UserInDB:
    """Verify the calling user may access the agent.

    Three-layer model:
      - admin (super-admin in agentscope) → always pass
      - tenant_admin → agent must be in the active tenant's assigned_agents pool
      - tenant member → agent must be in the per-user assigned resources
      - legacy user (no tenant) → fall back to bound_agent_ids (pre-migration)

    agentscope uses a shared ``x-user-id: webui`` namespace, so webui's RBAC
    layer must enforce agent ownership here. Without this check any authenticated
    user could read or overwrite another user's agent config (horizontal
    privilege escalation).
    """
    if user.role == "admin":
        return user
    if not user_can_access_agent(user, agent_id):
        logger.warning("priv-esc attempt: user=%s agent=%s tenant=%s",
                       user.id, agent_id, user.tenant_id or "-")
        raise HTTPException(403, f"No access to agent '{agent_id}'")
    return user


# ── Per-agent model config ────────────────────────────────────────────────────

@router.get("/agent-model/{agent_id}")
async def get_agent_model(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_json(f"webui:config:agent-model:{agent_id}") or {}


@router.put("/agent-model/{agent_id}")
async def set_agent_model(
    agent_id: str,
    config: ChatModelConfig,
    _: UserInDB = Depends(require_agent_access),
):
    _set_json(f"webui:config:agent-model:{agent_id}", config.model_dump())
    return config


@router.delete("/agent-model/{agent_id}", status_code=204)
async def delete_agent_model(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    _r().delete(f"webui:config:agent-model:{agent_id}")


# ── Per-agent MCP & skill bindings ────────────────────────────────────────────

# _allowed_mcps / _allowed_skills live in webui_helpers (shared with the
# mcp/skill list endpoints that scope non-admin views to the tenant pool).



@router.get("/agent-mcps/{agent_id}")
async def get_agent_mcps(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-mcps:{agent_id}")


@router.put("/agent-mcps/{agent_id}")
async def set_agent_mcps(
    agent_id: str,
    body: list = Body(...),
    user: UserInDB = Depends(require_agent_access),
):
    allowed = _allowed_mcps(user)
    if allowed is not None:
        excess = [m for m in body if m not in allowed]
        if excess:
            raise HTTPException(400, f"MCPs not available to you: {excess}")
    _set_list(f"webui:config:agent-mcps:{agent_id}", body)
    return body


@router.get("/agent-skills/{agent_id}")
async def get_agent_skills(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-skills:{agent_id}")


@router.put("/agent-skills/{agent_id}")
async def set_agent_skills(
    agent_id: str,
    body: list = Body(...),
    user: UserInDB = Depends(require_agent_access),
):
    allowed = _allowed_skills(user)
    if allowed is not None:
        excess = [s for s in body if s not in allowed]
        if excess:
            raise HTTPException(400, f"Skills not available to you: {excess}")
    _set_list(f"webui:config:agent-skills:{agent_id}", body)
    return body


# ── Per-agent preset questions ────────────────────────────────────────────────

@router.get("/agent-questions/{agent_id}")
async def get_agent_questions(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-questions:{agent_id}")


@router.put("/agent-questions/{agent_id}")
async def set_agent_questions(
    agent_id: str,
    body: list = Body(...),
    _: UserInDB = Depends(require_agent_access),
):
    cleaned = [q.strip() for q in body if isinstance(q, str) and q.strip()][:5]
    _set_list(f"webui:config:agent-questions:{agent_id}", cleaned)
    return cleaned


# ── Per-agent security level ──────────────────────────────────────────────────

class AgentSecurityConfig(BaseModel):
    level: Literal["strict", "workspace", "standard", "open"] = "workspace"


@router.get("/agent-security/{agent_id}")
async def get_agent_security(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_json(_agent_security_key(agent_id)) or {"level": "workspace"}


@router.put("/agent-security/{agent_id}")
async def set_agent_security(
    agent_id: str,
    body: AgentSecurityConfig,
    user: UserInDB = Depends(require_agent_access),
):
    if user.role != "admin":
        raise HTTPException(403, "Security level can only be set by admin")
    _set_json(_agent_security_key(agent_id), body.model_dump())
    return body


# ── Agent skills — full resolution ────────────────────────────────────────────

@router.get("/agent-skills-full/{agent_id}")
async def get_agent_skills_full(
    agent_id: str,
    user: UserInDB = Depends(require_agent_access),
):
    """Return the agent's bound skills as full objects ({name, path, is_enabled}).

    Unlike /skill-lib (which scans the *calling user's* registered skill-dirs
    and returns nothing for non-admins who haven't registered any), this
    resolves names directly from the stored SKILL.md paths — so any user with
    access to the agent can see its bound skills in the chat skill-picker.
    """
    paths = _get_list(f"webui:config:agent-skills:{agent_id}")
    # Agent-bound skills are admin-managed resources; always use the admin
    # namespace so that admin skill toggles are visible to all users.
    disabled = set(_get_list(_skill_disabled_key("admin")))
    return [
        {
            "name": pathlib.Path(p).parent.name,
            "path": p,
            "is_enabled": p not in disabled,
        }
        for p in paths
    ]
