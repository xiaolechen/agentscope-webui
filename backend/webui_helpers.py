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

# Root directory for user knowledge bases. Each KB lives under this path and
# is initialized by the llm-wiki-agent with a row/ + index/ structure.
LLM_WIKI_PATH: str = os.path.expanduser(os.getenv("LLM_WIKI_PATH", "~/llm-wiki"))

# Production security — set PRODUCTION_MODE=true to restrict agent Bash tool
# to read-only commands and block stdio MCP injection. Default: off (dev env).
PRODUCTION_MODE: bool = os.getenv("PRODUCTION_MODE", "false").lower() in ("true", "1", "yes")
# PermissionMode applied in production. "explore" = read-only (blocks ip a/curl/etc.);
# "accept_edits" = allows file writes within workspace but not path traversal.
PRODUCTION_PERMISSION_MODE: str = os.getenv("PRODUCTION_PERMISSION_MODE", "explore")

# Per-agent security levels. Each maps to an agentscope PermissionMode.
# Default when unset: "workspace" (accept_edits — workspace-only read/write).
# PRODUCTION_MODE floors 'standard' down to 'workspace' (unattended ASK for
# dangerous ops is fragile in production). An explicit 'open' (bypass) is
# HONORED even in production: it's an admin's deliberate per-agent trust
# grant — without this, agents that must write outside their workspace
# workdir (e.g. the llm-wiki-agent writing to the KB path) cannot function
# in production, because agentscope exposes no API to register the KB path
# as an allowed working directory. 'open' is admin-gated (PUT
# /webui/agent-security is admin-only), so honoring it is an admin trust
# decision, not a default.
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

    Applies the PRODUCTION_MODE floor: when enabled, 'standard' is clamped
    to 'workspace' (unattended ASK-for-dangerous-ops is fragile in prod).
    An explicit 'open' (bypass) is honored even in production — it is an
    admin's deliberate trust grant for that agent (e.g. the llm-wiki-agent,
    which must write to the KB path outside its workspace workdir).
    """
    raw = _get_json(_agent_security_key(agent_id)) or {}
    level: str = raw.get("level", _DEFAULT_SECURITY_LEVEL)
    if level not in LEVEL_TO_PERMISSION_MODE:
        level = _DEFAULT_SECURITY_LEVEL
    if PRODUCTION_MODE and level == "standard":
        level = "workspace"
    return LEVEL_TO_PERMISSION_MODE[level]


# ── Shared Pydantic model ─────────────────────────────────────────────────────

class ChatModelConfig(BaseModel):
    type: str
    credential_id: str
    model: str
    parameters: dict = {}


# ── Tenant model & menu permissions ──────────────────────────────────────────
#
# Menu permission codes correspond 1:1 to sidebar nav items. Admin always has
# ALL_MENU_PERMS; a tenant's menu_permissions is the subset its members see.
# Defaults: legacy users (no tenant) get the Workspace group so existing
# non-admin logins keep working.

ALL_MENU_PERMS: list[str] = [
    "chat", "sessions", "knowledge", "schedules",
    "agents", "skills", "mcp",
    "credentials", "logs", "settings", "users",
]

# What a user sees when they have no tenant (legacy / pre-migration). Keeps the
# original Workspace-only behaviour for non-admins intact.
_DEFAULT_MENU_PERMS: list[str] = ["chat", "sessions", "knowledge", "schedules"]


class Tenant(BaseModel):
    id: str
    name: str                       # URL-safe slug, unique
    display_name: str               # human-readable
    created_by: str                 # admin user id
    created_at: str                 # ISO timestamp
    # Feature permissions: which sidebar pages the tenant's members can see.
    menu_permissions: list[str] = list(_DEFAULT_MENU_PERMS)
    # Resource assignment pools (populated by admin, enforced in Phase 2).
    assigned_agents: list[str] = []
    assigned_mcps: list[str] = []
    assigned_skills: list[str] = []
    assigned_credentials: list[str] = []
    # Org tree (Phase 4). Reserved now so serializers are stable.
    org_structure: list[dict] = []


def get_tenant(tenant_id: Optional[str]) -> Optional[Tenant]:
    """Load a tenant by id. Returns None if id is empty/missing/not found."""
    if not tenant_id:
        return None
    raw = _get_json(_tenant_key(tenant_id))
    if not raw:
        return None
    try:
        return Tenant(**raw)
    except Exception as e:
        logger.error("invalid tenant record id=%s: %s", tenant_id, e)
        return None


def save_tenant(tenant: Tenant) -> None:
    """Persist a tenant and maintain the id set."""
    r = _r()
    pipe = r.pipeline()
    pipe.set(_tenant_key(tenant.id), tenant.model_dump_json())
    pipe.sadd(_tenant_all_key(), tenant.id)
    pipe.execute()


def resolve_menu_permissions(user) -> list[str]:
    """Return the list of menu permission codes visible to this user.

    - admin → all
    - tenant_admin with a tenant → the tenant's menu_permissions (they manage
      members and view the pool)
    - user (member) with a tenant → the tenant's menu_permissions MINUS the
      configuration pages (agents/skills/mcp) and the Users page. Members
      never configure resources or manage users — the tenant admin binds
      agents on their behalf, and members consume them via chat.
    - user with no tenant (legacy) → the workspace defaults
    """
    if user.role == "admin":
        return list(ALL_MENU_PERMS)
    tenant = get_tenant(getattr(user, "tenant_id", None))
    base = list(tenant.menu_permissions) if tenant else list(_DEFAULT_MENU_PERMS)
    if user.role == "user":
        # Members never see the configuration pages (agents/skills/mcp) — the
        # tenant admin binds agents on their behalf, and members consume them
        # via chat. They may still see the Users page (their own record only),
        # but the add-user button is role-gated in the UI.
        excluded = {"agents", "skills", "mcp"}
        base = [p for p in base if p not in excluded]
    return base


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


def _schedule_key(user_id: str) -> str:
    """Per-user set of schedule IDs created by that user.

    Schedules are creator-owned runtime data (same model as sessions, chat, and
    knowledge bases) — NOT tenant-pool config resources like agents/skills/mcps.
    Visibility flows from creator ownership: admin sees all, tenant_admin sees
    the union across their tenant's members, a member sees only their own.
    """
    return f"webui:user-schedules:{user_id}"


def _agent_security_key(agent_id: str) -> str:
    return f"webui:config:agent-security:{agent_id}"


def _knowledge_base_key(owner: str) -> str:
    return f"webui:config:knowledge-base:{owner}"


# ── Tenant key helpers ────────────────────────────────────────────────────────
#
# Multi-tenant permission model. A Tenant owns: a set of members, a menu-
# permission list (which sidebar pages its members can see), and resource-
# assignment lists (which agents/mcps/skills/credentials the tenant can use).
# Users reference their tenant via UserInDB.tenant_id; the reverse index
# (`webui:user:tenant:{user_id}`) lets us look up a user's tenant without
# loading the full user record.

def _tenant_key(tenant_id: str) -> str:
    return f"webui:tenant:{tenant_id}"


def _tenant_all_key() -> str:
    return "webui:tenant:all"


def _tenant_members_key(tenant_id: str) -> str:
    return f"webui:tenant:members:{tenant_id}"


def _tenant_admins_key(tenant_id: str) -> str:
    return f"webui:tenant:admins:{tenant_id}"


def _user_tenant_key(user_id: str) -> str:
    return f"webui:user:tenant:{user_id}"


# ── Multi-tenant membership helpers ───────────────────────────────────────────
#
# A user may belong to multiple tenants, with a per-tenant role
# (admin | tenant_admin | user). Stored as a Redis HASH so we can read one
# role or all memberships without loading the full user record.
# UserInDB.role / .tenant_id keep their meaning as the *currently active*
# context (set at login / switch); the HASH is the source of truth for the
# full membership set.

def _user_memberships_key(user_id: str) -> str:
    return f"webui:user:memberships:{user_id}"


def _user_resources_key(tenant_id: str, user_id: str) -> str:
    """Per-user resource assignment within a tenant. A JSON object with
    agents/mcps/skills arrays; each must be a subset of the tenant's
    assigned_* pool (enforced by the router)."""
    return f"webui:user:resources:{tenant_id}:{user_id}"


def get_user_memberships(user_id: str) -> dict[str, str]:
    """All memberships for a user as {tenant_id: role}. Empty dict if none."""
    try:
        raw = _r().hgetall(_user_memberships_key(user_id))
        return raw or {}
    except Exception as e:
        logger.error("memberships read error user=%s: %s", user_id, e)
        return {}


def get_user_member_role(user_id: str, tenant_id: str) -> Optional[str]:
    """The user's role in a specific tenant, or None if not a member."""
    if not tenant_id:
        return None
    try:
        return _r().hget(_user_memberships_key(user_id), tenant_id)
    except Exception as e:
        logger.error("member-role read error user=%s tenant=%s: %s", user_id, tenant_id, e)
        return None


def link_user_to_tenant(user, tenant_id: str, role: str):
    """Attach (or move) a user into a tenant with the given role.

    Updates the memberships HASH and the reverse-index sets. The caller is
    responsible for setting user.role/tenant_id on the active context and
    persisting the user record. Uses model_copy to stay immutable.
    """
    from auth_router import save_user
    r = _r()
    pipe = r.pipeline()
    pipe.hset(_user_memberships_key(user.id), tenant_id, role)
    pipe.set(_user_tenant_key(user.id), tenant_id)
    pipe.sadd(_tenant_members_key(tenant_id), user.id)
    if role == "tenant_admin" or role == "admin":
        pipe.sadd(_tenant_admins_key(tenant_id), user.id)
    else:
        pipe.srem(_tenant_admins_key(tenant_id), user.id)
    pipe.execute()
    # Active context follows the new membership.
    updated = user.model_copy(update={"tenant_id": tenant_id, "role": role})
    save_user(updated)
    return updated


def unlink_user_from_tenant(user, tenant_id: str):
    """Remove a user's membership in a tenant. Does not touch other
    memberships. If the active tenant_id was this one, the caller must
    re-pick an active tenant (or the next login will)."""
    from auth_router import save_user
    r = _r()
    pipe = r.pipeline()
    pipe.hdel(_user_memberships_key(user.id), tenant_id)
    pipe.srem(_tenant_members_key(tenant_id), user.id)
    pipe.srem(_tenant_admins_key(tenant_id), user.id)
    pipe.delete(_user_resources_key(tenant_id, user.id))
    # If the active tenant was this one, clear the active pointer so a stale
    # tenant_id isn't trusted. The login/switch flow re-resolves it.
    if user.tenant_id == tenant_id:
        pipe.delete(_user_tenant_key(user.id))
    pipe.execute()
    return user


def get_user_resources(tenant_id: str, user_id: str) -> dict:
    """Per-user resource assignment {agents, mcps, skills}. Defaults to empty
    lists — a user with no explicit assignment sees nothing from the pool."""
    raw = _get_json(_user_resources_key(tenant_id, user_id))
    if not raw:
        return {"agents": [], "mcps": [], "skills": []}
    return {
        "agents": raw.get("agents", []),
        "mcps": raw.get("mcps", []),
        "skills": raw.get("skills", []),
    }


def set_user_resources(tenant_id: str, user_id: str, resources: dict) -> None:
    _set_json(_user_resources_key(tenant_id, user_id), {
        "agents": resources.get("agents", []),
        "mcps": resources.get("mcps", []),
        "skills": resources.get("skills", []),
    })


# ── Effective resource scope (read-side) ─────────────────────────────────────
# Used by list endpoints (mcp-lib, skill-lib) and the agent-config write
# validation to scope what a non-admin may see/bind. None = unrestricted
# (admin / legacy no-tenant user); tenant_admin → tenant's assigned_* pool;
# member → per-user assigned subset. The pool references items in the *admin*
# config namespace, so callers must resolve against the admin namespace when
# serving non-admins (see mcp_router.get_mcp_lib / skill_router.get_skill_lib).

def _allowed_mcps(user: "UserInDB") -> Optional[set]:
    if user.role == "admin" or not user.tenant_id:
        return None
    tenant = get_tenant(user.tenant_id)
    if not tenant:
        return set()
    if user.role == "tenant_admin":
        return set(tenant.assigned_mcps)
    return set(get_user_resources(user.tenant_id, user.id).get("mcps", []))


def _allowed_skills(user: "UserInDB") -> Optional[set]:
    if user.role == "admin" or not user.tenant_id:
        return None
    tenant = get_tenant(user.tenant_id)
    if not tenant:
        return set()
    if user.role == "tenant_admin":
        return set(tenant.assigned_skills)
    return set(get_user_resources(user.tenant_id, user.id).get("skills", []))


def user_can_access_agent(user: "UserInDB", agent_id: str) -> bool:
    """Whether ``user`` may access ``agent_id`` under the three-layer model.

    Single source of truth for agent access — used by the agent-config router
    (``require_agent_access``) and session ownership tracking
    (``session_router.track_session``). Previously track_session checked the
    stale ``bound_agent_ids`` (set once at user creation, never updated on
    per-user reassignment), so a member who got a new agent via
    MemberResourcesDialog was 403'd on track_session. Centralising here keeps
    the read path identical to the config-write path.

      - admin            → always True
      - tenant_admin     → agent in the active tenant's assigned_agents pool
      - member (tenant)  → agent in the per-user assigned resources
      - legacy (no tenant) → fall back to bound_agent_ids (pre-migration)
    """
    if user.role == "admin":
        return True
    if not user.tenant_id:
        return agent_id in (user.bound_agent_ids or [])
    tenant = get_tenant(user.tenant_id)
    if not tenant:
        return False
    if user.role == "tenant_admin":
        return agent_id in tenant.assigned_agents
    return agent_id in get_user_resources(user.tenant_id, user.id).get("agents", [])


# The platform/system tenant. Admins live here; its members can create and
# configure other tenants but cannot add users to *those* tenants (that's the
# other tenant's tenant_admin's job). Created at bootstrap in auth_router.
PLATFORM_TENANT_ID = "agentscope"


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
    for kind in ("mcp-lib", "skill-dirs", "skill-disabled", "knowledge-base"):
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
            if kind in ("mcp-lib", "knowledge-base"):
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
