"""User management router — multi-tenant scoped CRUD.

Account-level fields (username, password, bound agents) live here. Tenant
*membership* (which tenant + role) is managed via tenant_router's member
endpoints; per-user resource assignment via tenant_router's resources
endpoints. This router only sets the initial membership at user creation
and adjusts the active context.

Visibility rules (the 'users' feature permission is required throughout):

- **admin** (role='admin' in the agentscope tenant) — full access to every
  user across tenants. May specify any tenant_id + role at creation.
- **tenant_admin** — may create/edit/delete users *within their own active
  tenant only*. Cannot create super-admins; bound agents must be a subset
  of the tenant's assigned_agents.
- **member / legacy** — may only see themselves; cannot create/edit/delete
  other users (403).
"""
import logging, uuid, json
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth_router import UserInDB, hash_password, save_user, get_user_by_id, _r
from permission_guard import require_feature
from webui_helpers import (
    get_tenant, get_user_memberships, link_user_to_tenant, unlink_user_from_tenant,
    get_user_member_role, _user_memberships_key, set_user_resources,
    _user_tenant_key, _tenant_members_key, _tenant_admins_key, _user_resources_key,
)

router = APIRouter(prefix="/users", tags=["users"])
logger = logging.getLogger(__name__)

# Feature-gate every endpoint here: admin passes, tenant members need the
# 'users' menu permission, legacy users pass through (they have no menu entry
# so they never call these in practice).
_users_feature = require_feature("users")


class UserResourcesBody(BaseModel):
    agents: list[str] = []
    mcps: list[str] = []
    skills: list[str] = []


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"
    bound_agent_ids: list[str] = []
    tenant_id: Optional[str] = None
    # Only used when a tenant_admin creates a regular user: the per-user
    # resource subset (agents/mcps/skills) drawn from the tenant's pool.
    # Ignored for tenant_admin/admin roles and for the agentscope admin path.
    resources: Optional[UserResourcesBody] = None


class UpdateUserRequest(BaseModel):
    password: str | None = None
    role: str | None = None
    bound_agent_ids: list[str] | None = None
    # null detaches the user from their active tenant; a value attaches/moves.
    tenant_id: str | None = None


def list_all_users() -> list[UserInDB]:
    ids = _r().smembers("webui:users:all")
    users = []
    for uid in ids:
        data = _r().get(f"webui:user:id:{uid}")
        if data:
            users.append(UserInDB(**json.loads(data)))
    return users


def _user_public(u: UserInDB) -> dict:
    return {
        "id": u.id, "username": u.username, "role": u.role,
        "bound_agent_ids": u.bound_agent_ids, "tenant_id": u.tenant_id,
    }


def _ensure_tenant_admin_scope(caller: UserInDB, target: UserInDB) -> None:
    """Reject a tenant_admin acting outside their tenant or on a super-admin.

    Admins bypass this (call only when caller.role != 'admin').
    """
    if target.role == "admin":
        raise HTTPException(403, "Cannot modify a super-admin")
    if target.tenant_id != caller.tenant_id:
        raise HTTPException(403, "User is not in your tenant")


def _check_bound_agents(caller: UserInDB, agent_ids: list[str]) -> None:
    """For tenant_admin, bound agents must be a subset of the tenant's pool.
    Admins bypass."""
    if not agent_ids:
        return
    tenant = get_tenant(caller.tenant_id)
    if not tenant:
        raise HTTPException(400, "Your tenant is not configured")
    unassigned = [a for a in agent_ids if a not in tenant.assigned_agents]
    if unassigned:
        raise HTTPException(
            400, f"Agents not assigned to your tenant: {unassigned}"
        )


@router.get("/")
async def list_users(caller: UserInDB = Depends(_users_feature)):
    """Data-scoped: admin=all, tenant_admin=own active tenant, member/legacy=self."""
    if caller.role == "admin":
        return [_user_public(u) for u in list_all_users()]
    if caller.role == "tenant_admin" and caller.tenant_id:
        return [
            _user_public(u) for u in list_all_users()
            if u.tenant_id == caller.tenant_id and u.role != "admin"
        ]
    # member / legacy: only themselves.
    return [_user_public(caller)]


@router.post("/", status_code=201)
async def create_user(req: CreateUserRequest, caller: UserInDB = Depends(_users_feature)):
    if caller.role != "admin":
        if caller.role != "tenant_admin" or not caller.tenant_id:
            raise HTTPException(403, "Only administrators can create users")
        # tenant_admin: force into own active tenant, no super-admin role,
        # agents ⊆ pool.
        if req.role == "admin":
            raise HTTPException(403, "Cannot create a super-admin")
        _check_bound_agents(caller, req.bound_agent_ids)
        # When creating a regular user, the tenant_admin must also assign a
        # per-user resource subset (agents/mcps/skills) from the tenant pool.
        # tenant_admin role inherits the full pool, so no assignment is needed.
        if req.role == "user":
            if not req.resources:
                raise HTTPException(
                    400, "A regular user requires an initial resource assignment"
                )
            tenant = get_tenant(caller.tenant_id)
            if not tenant:
                raise HTTPException(400, "Your tenant is not configured")
            for field, pool in (
                ("agents", tenant.assigned_agents),
                ("mcps", tenant.assigned_mcps),
                ("skills", tenant.assigned_skills),
            ):
                requested = getattr(req.resources, field)
                excess = [x for x in requested if x not in pool]
                if excess:
                    raise HTTPException(
                        400, f"{field} not assigned to your tenant: {excess}"
                    )
        else:
            req = req.model_copy(update={"resources": None})
        req = req.model_copy(update={
            "tenant_id": caller.tenant_id,
            "role": req.role if req.role in ("tenant_admin", "user") else "user",
        })

    # Admin path keeps the original cross-tenant validation.
    if caller.role == "admin":
        if req.role == "admin" and req.tenant_id and req.tenant_id != "agentscope":
            raise HTTPException(400, "Super-admins belong to the agentscope tenant only")
        if req.tenant_id and not get_tenant(req.tenant_id):
            raise HTTPException(404, f"Tenant '{req.tenant_id}' not found")
        # agentscope admin does not assign per-user resources at creation time;
        # the tenant_admin of the target tenant does that later.
        req = req.model_copy(update={"resources": None})

    user = UserInDB(
        id=str(uuid.uuid4()),
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        bound_agent_ids=req.bound_agent_ids,
        tenant_id=req.tenant_id,
    )
    save_user(user)
    # Register the initial membership (also persists the active context).
    if req.tenant_id:
        link_user_to_tenant(user, req.tenant_id, req.role)
    # Apply the per-user resource subset for tenant_admin-created users.
    if req.resources and req.tenant_id:
        set_user_resources(req.tenant_id, user.id, req.resources.model_dump())
    logger.info("caller=%s created user=%s role=%s tenant=%s",
                caller.username, user.username, user.role, req.tenant_id)
    return _user_public(user)


@router.patch("/{user_id}")
async def update_user(user_id: str, req: UpdateUserRequest, caller: UserInDB = Depends(_users_feature)):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")

    # tenant_admin scope guard (admin skips).
    if caller.role != "admin":
        if caller.role != "tenant_admin" or not caller.tenant_id:
            raise HTTPException(403, "Only administrators can edit users")
        _ensure_tenant_admin_scope(caller, user)
        if req.role == "admin":
            raise HTTPException(403, "Cannot promote to super-admin")
        if req.tenant_id is not None and req.tenant_id != caller.tenant_id:
            raise HTTPException(403, "Cannot move a user out of your tenant")
        if req.bound_agent_ids is not None:
            _check_bound_agents(caller, req.bound_agent_ids)

    changed = list(req.model_dump(exclude_unset=True).keys())
    if req.password:
        user = user.model_copy(update={"hashed_password": hash_password(req.password)})
    if req.bound_agent_ids is not None:
        user = user.model_copy(update={"bound_agent_ids": req.bound_agent_ids})
    save_user(user)

    # Role change or tenant move → re-link membership (updates the memberships
    # HASH and the active context). A null tenant_id detaches from the active
    # tenant. The role applies within the target tenant.
    if req.tenant_id is not None or req.role is not None:
        if req.tenant_id is None and req.role is not None:
            # Role-only change in the user's current active tenant.
            target_tenant = user.tenant_id
        else:
            target_tenant = req.tenant_id or None
        effective_role = req.role or get_user_member_role(user.id, target_tenant) or "user"
        if target_tenant:
            link_user_to_tenant(user, target_tenant, effective_role)
        elif user.tenant_id:
            unlink_user_from_tenant(user, user.tenant_id)

    logger.info("caller=%s updated user=%s fields=%s", caller.username, user.username, changed)
    return _user_public(get_user_by_id(user_id) or user)


@router.delete("/{user_id}", status_code=204)
async def delete_user(user_id: str, caller: UserInDB = Depends(_users_feature)):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if caller.role != "admin":
        if caller.role != "tenant_admin" or not caller.tenant_id:
            raise HTTPException(403, "Only administrators can delete users")
        _ensure_tenant_admin_scope(caller, user)
    logger.info("caller=%s deleted user=%s role=%s", caller.username, user.username, user.role)
    # Clean up all memberships + reverse indexes across every tenant.
    memberships = get_user_memberships(user.id)
    r = _r()
    pipe = r.pipeline()
    pipe.delete(f"webui:user:id:{user_id}", f"webui:user:name:{user.username}")
    pipe.srem("webui:users:all", user_id)
    pipe.delete(_user_tenant_key(user_id))
    pipe.delete(_user_memberships_key(user_id))
    for tid in memberships:
        pipe.srem(_tenant_members_key(tid), user_id)
        pipe.srem(_tenant_admins_key(tid), user_id)
        pipe.delete(_user_resources_key(tid, user_id))
    pipe.execute()
