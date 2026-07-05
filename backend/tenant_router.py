"""Tenant management router — platform-gated CRUD + scoped member assignment.

Three-layer model:
  - Platform operators (members of the 'agentscope' tenant) create and
    configure tenants (menu permissions + assigned resource pools).
  - A tenant's own tenant_admin manages that tenant's members and assigns
    per-user resources (agents/mcps/skills) from the tenant's pool.
  - The super-admin (role='admin' in the agentscope tenant) retains full
    power across all tenants.

A user may belong to multiple tenants; memberships live in
`webui:user:memberships:{user_id}` (HASH {tenant_id: role}). UserInDB.role
and .tenant_id reflect the *currently active* context.
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_router import UserInDB, current_user, get_user_by_id, _r
from permission_guard import require_platform_access
from webui_helpers import (
    ALL_MENU_PERMS,
    Tenant,
    get_tenant,
    save_tenant,
    link_user_to_tenant,
    unlink_user_from_tenant,
    get_user_member_role,
    get_user_resources,
    set_user_resources,
    _tenant_key,
    _tenant_all_key,
    _tenant_members_key,
    _tenant_admins_key,
    PLATFORM_TENANT_ID,
)

router = APIRouter(prefix="/webui/tenants", tags=["tenants"])
logger = logging.getLogger(__name__)


# ── Request models ────────────────────────────────────────────────────────────

class CreateTenantRequest(BaseModel):
    name: str                        # URL-safe slug, unique
    display_name: str
    menu_permissions: Optional[list[str]] = None   # defaults to workspace set
    assigned_agents: list[str] = []
    assigned_mcps: list[str] = []
    assigned_skills: list[str] = []
    assigned_credentials: list[str] = []


class UpdateTenantRequest(BaseModel):
    display_name: Optional[str] = None
    menu_permissions: Optional[list[str]] = None
    assigned_agents: Optional[list[str]] = None
    assigned_mcps: Optional[list[str]] = None
    assigned_skills: Optional[list[str]] = None
    assigned_credentials: Optional[list[str]] = None
    org_structure: Optional[list[dict]] = None


class AddMembersRequest(BaseModel):
    user_ids: list[str]
    role: str = "user"               # "tenant_admin" | "user"


class SetMemberRoleRequest(BaseModel):
    role: str                        # "tenant_admin" | "user"


class UserResourcesRequest(BaseModel):
    agents: list[str] = []
    mcps: list[str] = []
    skills: list[str] = []


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sanitize_name(name: str) -> str:
    """Reject names that aren't URL-safe slugs — they end up in Redis keys
    and JSON paths, so we keep them conservative. The platform tenant id is
    reserved."""
    name = name.strip()
    if not name or len(name) > 64:
        raise HTTPException(400, "Tenant name must be 1–64 chars")
    if not all(c.isalnum() or c in "-_" for c in name):
        raise HTTPException(400, "Tenant name may only contain letters, digits, - and _")
    if name == PLATFORM_TENANT_ID:
        raise HTTPException(400, f"'{PLATFORM_TENANT_ID}' is a reserved tenant name")
    return name


def _normalize_menu_perms(perms: Optional[list[str]]) -> Optional[list[str]]:
    if perms is None:
        return None  # caller decides the default
    invalid = [p for p in perms if p not in ALL_MENU_PERMS]
    if invalid:
        raise HTTPException(400, f"Unknown menu permissions: {invalid}")
    seen, out = set(), []
    for p in perms:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _tenant_public(t: Tenant, member_count: Optional[int] = None) -> dict:
    d = t.model_dump()
    if member_count is not None:
        d["member_count"] = member_count
    return d


def _assert_can_manage_tenant(caller: UserInDB, tenant_id: str) -> None:
    """Who may manage a tenant's members:
      - super-admin (role='admin') → any tenant
      - platform tenant members → the platform tenant only
      - a regular tenant's tenant_admin → their own tenant
    """
    if caller.role == "admin":
        return
    role_here = get_user_member_role(caller.id, tenant_id)
    if role_here is None and caller.tenant_id == tenant_id \
            and caller.role in ("tenant_admin", "admin"):
        # Legacy fallback: the caller's active context (set at login from a
        # membership or from the admin-set user.tenant_id) says they administer
        # this tenant, but no membership HASH entry exists — a pre-migration
        # user created before the memberships HASH existed. Trust the active
        # context and backfill the membership so future reads skip this branch.
        link_user_to_tenant(caller, tenant_id, caller.role)
        role_here = caller.role
    if tenant_id == PLATFORM_TENANT_ID:
        # Any platform member can manage platform members.
        if not role_here:
            raise HTTPException(403, "Platform members only")
        return
    if role_here not in ("tenant_admin", "admin"):
        raise HTTPException(403, "Tenant admin only")


def _validate_member_role(tenant_id: str, role: str) -> None:
    """role 'admin' is reserved for the platform tenant; regular tenants only
    get 'tenant_admin' / 'user'."""
    if role not in ("tenant_admin", "user"):
        if role == "admin" and tenant_id == PLATFORM_TENANT_ID:
            return
        raise HTTPException(400, "role must be 'tenant_admin' or 'user'")


# ── Tenant CRUD (platform-gated) ──────────────────────────────────────────────

@router.get("")
async def list_tenants(caller: UserInDB = Depends(require_platform_access)):
    ids = _r().smembers(_tenant_all_key())
    out = []
    for tid in ids:
        t = get_tenant(tid)
        if not t:
            continue
        out.append(_tenant_public(t, _r().scard(_tenant_members_key(tid))))
    return out


# NOTE: defined before /{tenant_id} so the static path wins. Lets any tenant
# member read their own tenant (used by the non-admin Users page to filter the
# bound-agent picker to assigned_agents and to power the tenant switcher).
@router.get("/my-tenant")
async def get_my_tenant(user: UserInDB = Depends(current_user)):
    if not user.tenant_id:
        raise HTTPException(404, "You are not in a tenant")
    t = get_tenant(user.tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    return _tenant_public(t, _r().scard(_tenant_members_key(user.tenant_id)))


@router.get("/my-resources")
async def get_my_resources(user: UserInDB = Depends(current_user)):
    """The caller's effective resource set in their active tenant:
      - admin → the tenant's full pool (or empty if no active tenant)
      - tenant_admin → the tenant's full assigned_* pool
      - member → the per-user assigned resources
    Frontend uses this to filter agent/skill/mcp pickers.
    """
    if not user.tenant_id:
        return {"agents": [], "mcps": [], "skills": []}
    t = get_tenant(user.tenant_id)
    if not t:
        return {"agents": [], "mcps": [], "skills": []}
    if user.role in ("admin", "tenant_admin"):
        return {
            "agents": list(t.assigned_agents),
            "mcps": list(t.assigned_mcps),
            "skills": list(t.assigned_skills),
        }
    return get_user_resources(user.tenant_id, user.id)


@router.post("", status_code=201)
async def create_tenant(req: CreateTenantRequest, caller: UserInDB = Depends(require_platform_access)):
    name = _sanitize_name(req.name)
    if _r().exists(_tenant_key(name)):
        raise HTTPException(409, f"Tenant '{name}' already exists")
    tenant = Tenant(
        id=name,
        name=name,
        display_name=req.display_name or name,
        created_by=caller.id,
        created_at=datetime.utcnow().isoformat() + "Z",
        menu_permissions=_normalize_menu_perms(req.menu_permissions) or ["chat", "sessions", "knowledge", "schedules"],
        assigned_agents=req.assigned_agents,
        assigned_mcps=req.assigned_mcps,
        assigned_skills=req.assigned_skills,
        assigned_credentials=req.assigned_credentials,
    )
    save_tenant(tenant)
    logger.info("caller=%s created tenant=%s", caller.username, tenant.id)
    return _tenant_public(tenant, member_count=0)


@router.get("/{tenant_id}")
async def get_tenant_detail(tenant_id: str, caller: UserInDB = Depends(require_platform_access)):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    return _tenant_public(t, _r().scard(_tenant_members_key(tenant_id)))


@router.put("/{tenant_id}")
async def update_tenant(tenant_id: str, req: UpdateTenantRequest, caller: UserInDB = Depends(require_platform_access)):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    updates: dict = {}
    if req.display_name is not None:
        updates["display_name"] = req.display_name
    if req.menu_permissions is not None:
        updates["menu_permissions"] = _normalize_menu_perms(req.menu_permissions)
    if req.assigned_agents is not None:
        updates["assigned_agents"] = req.assigned_agents
    if req.assigned_mcps is not None:
        updates["assigned_mcps"] = req.assigned_mcps
    if req.assigned_skills is not None:
        updates["assigned_skills"] = req.assigned_skills
    if req.assigned_credentials is not None:
        updates["assigned_credentials"] = req.assigned_credentials
    if req.org_structure is not None:
        updates["org_structure"] = req.org_structure
    t = t.model_copy(update=updates)
    save_tenant(t)
    logger.info("caller=%s updated tenant=%s fields=%s", caller.username, tenant_id, list(updates.keys()))
    return _tenant_public(t, _r().scard(_tenant_members_key(tenant_id)))


@router.delete("/{tenant_id}", status_code=204)
async def delete_tenant(tenant_id: str, caller: UserInDB = Depends(require_platform_access)):
    if tenant_id == PLATFORM_TENANT_ID:
        raise HTTPException(400, "The platform tenant cannot be deleted")
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    # Detach all members first so no user is left pointing at a deleted tenant.
    for uid in _r().smembers(_tenant_members_key(tenant_id)):
        u = get_user_by_id(uid)
        if u:
            unlink_user_from_tenant(u, tenant_id)
    r = _r()
    pipe = r.pipeline()
    pipe.delete(_tenant_key(tenant_id))
    pipe.srem(_tenant_all_key(), tenant_id)
    pipe.delete(_tenant_members_key(tenant_id))
    pipe.delete(_tenant_admins_key(tenant_id))
    pipe.execute()
    logger.info("caller=%s deleted tenant=%s", caller.username, tenant_id)


# ── Member management (scoped) ────────────────────────────────────────────────

@router.get("/{tenant_id}/members")
async def list_members(tenant_id: str, caller: UserInDB = Depends(current_user)):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    admin_ids = _r().smembers(_tenant_admins_key(tenant_id))
    out = []
    for uid in _r().smembers(_tenant_members_key(tenant_id)):
        u = get_user_by_id(uid)
        if not u:
            continue
        out.append({
            "id": u.id,
            "username": u.username,
            "role": get_user_member_role(u.id, tenant_id) or u.role,
            "org_path": u.org_path,
            "is_tenant_admin": u.id in admin_ids,
        })
    return out


@router.post("/{tenant_id}/members", status_code=201)
async def add_members(
    tenant_id: str,
    req: AddMembersRequest,
    caller: UserInDB = Depends(current_user),
):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    _validate_member_role(tenant_id, req.role)
    added = []
    for uid in req.user_ids:
        u = get_user_by_id(uid)
        if not u:
            raise HTTPException(404, f"User {uid} not found")
        existing = get_user_member_role(u.id, tenant_id)
        if existing:
            raise HTTPException(409, f"User '{u.username}' is already a member of this tenant")
        link_user_to_tenant(u, tenant_id, req.role)
        added.append(uid)
    logger.info("caller=%s added members to tenant=%s: %s", caller.username, tenant_id, added)
    return {"added": added}


@router.delete("/{tenant_id}/members/{user_id}", status_code=204)
async def remove_member(
    tenant_id: str,
    user_id: str,
    caller: UserInDB = Depends(current_user),
):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    u = get_user_by_id(user_id)
    if not u:
        raise HTTPException(404, "User not found")
    if not get_user_member_role(u.id, tenant_id):
        raise HTTPException(409, "User does not belong to this tenant")
    unlink_user_from_tenant(u, tenant_id)
    logger.info("caller=%s removed member=%s from tenant=%s", caller.username, u.username, tenant_id)


@router.put("/{tenant_id}/members/{user_id}")
async def set_member_role(
    tenant_id: str,
    user_id: str,
    req: SetMemberRoleRequest,
    caller: UserInDB = Depends(current_user),
):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    _validate_member_role(tenant_id, req.role)
    u = get_user_by_id(user_id)
    if not u:
        raise HTTPException(404, "User not found")
    if not get_user_member_role(u.id, tenant_id):
        raise HTTPException(409, "User does not belong to this tenant")
    link_user_to_tenant(u, tenant_id, req.role)
    logger.info("caller=%s set member=%s role=%s in tenant=%s",
                caller.username, u.username, req.role, tenant_id)
    return {"id": u.id, "username": u.username, "role": req.role}


# ── Per-user resource assignment ──────────────────────────────────────────────
#
# A tenant_admin assigns a subset of the tenant's assigned_* pool to each
# member. Members see only what's assigned to them (enforced in the config
# routers + frontend filtering).

@router.get("/{tenant_id}/members/{user_id}/resources")
async def get_member_resources(
    tenant_id: str,
    user_id: str,
    caller: UserInDB = Depends(current_user),
):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    if not get_user_member_role(user_id, tenant_id):
        raise HTTPException(404, "User is not a member of this tenant")
    return get_user_resources(tenant_id, user_id)


@router.put("/{tenant_id}/members/{user_id}/resources")
async def set_member_resources(
    tenant_id: str,
    user_id: str,
    req: UserResourcesRequest,
    caller: UserInDB = Depends(current_user),
):
    t = get_tenant(tenant_id)
    if not t:
        raise HTTPException(404, "Tenant not found")
    _assert_can_manage_tenant(caller, tenant_id)
    if not get_user_member_role(user_id, tenant_id):
        raise HTTPException(404, "User is not a member of this tenant")
    # Every assigned id must be within the tenant's pool.
    for field, pool in (
        ("agents", t.assigned_agents),
        ("mcps", t.assigned_mcps),
        ("skills", t.assigned_skills),
    ):
        requested = getattr(req, field)
        excess = [x for x in requested if x not in pool]
        if excess:
            raise HTTPException(400, f"{field} not in tenant pool: {excess}")
    set_user_resources(tenant_id, user_id, {
        "agents": req.agents,
        "mcps": req.mcps,
        "skills": req.skills,
    })
    logger.info("caller=%s set resources for user=%s in tenant=%s",
                caller.username, user_id, tenant_id)
    return get_user_resources(tenant_id, user_id)
