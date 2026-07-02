"""Per-agent configuration — model, MCP bindings, skill bindings, preset questions."""
import logging, pathlib

from fastapi import APIRouter, Body, Depends, HTTPException
from auth_router import UserInDB, current_user, _r
from webui_helpers import (
    ChatModelConfig,
    _config_owner, _get_json, _set_json, _get_list, _set_list,
    _skill_disabled_key,
)

router = APIRouter(prefix="/webui", tags=["webui"])
logger = logging.getLogger(__name__)


# ── Access control ────────────────────────────────────────────────────────────

async def require_agent_access(
    agent_id: str,
    user: UserInDB = Depends(current_user),
) -> UserInDB:
    """Verify the calling user owns the agent; admins bypass this check.

    agentscope uses a shared ``x-user-id: webui`` namespace, so webui's RBAC
    layer must enforce agent ownership here. Without this check any authenticated
    user could read or overwrite another user's agent model/MCP/skill config
    (horizontal privilege escalation).
    """
    if user.role == "admin":
        return user
    if agent_id not in user.bound_agent_ids:
        logger.warning("priv-esc attempt: user=%s agent=%s", user.id, agent_id)
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

@router.get("/agent-mcps/{agent_id}")
async def get_agent_mcps(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-mcps:{agent_id}")


@router.put("/agent-mcps/{agent_id}")
async def set_agent_mcps(
    agent_id: str,
    body: list = Body(...),
    _: UserInDB = Depends(require_agent_access),
):
    _set_list(f"webui:config:agent-mcps:{agent_id}", body)
    return body


@router.get("/agent-skills/{agent_id}")
async def get_agent_skills(agent_id: str, _: UserInDB = Depends(require_agent_access)):
    return _get_list(f"webui:config:agent-skills:{agent_id}")


@router.put("/agent-skills/{agent_id}")
async def set_agent_skills(
    agent_id: str,
    body: list = Body(...),
    _: UserInDB = Depends(require_agent_access),
):
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
