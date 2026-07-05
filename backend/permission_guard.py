"""Permission guards for the multi-tenant model.

Two orthogonal layers (see the plan's "权限双层模型"):

1. Feature permissions — can the user see / call a given page or API area?
   Driven by the tenant's `menu_permissions`. Implemented as FastAPI
   dependencies (require_feature, require_resource_access).

2. Data permissions — whose records can the user read? Computed per-request
   via get_data_scope() and applied as a filter inside list endpoints.

Backward compatibility: a user with no tenant_id (legacy, pre-migration) is
treated like the old `current_user` — feature checks pass through, data scope
is "own user_id". This keeps existing non-admin logins working unchanged
until they are explicitly assigned to a tenant.
"""
import logging
from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, HTTPException

from auth_router import UserInDB, current_user
from webui_helpers import get_tenant, get_user_member_role, PLATFORM_TENANT_ID

logger = logging.getLogger(__name__)


# ── Data permission scope ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class DataScope:
    """What data the caller can see.

    type='all'         — super-admin: every record across tenants
    type='tenant'      — tenant_admin: all records within own tenant
    type='own'         — member: only records created by self (scoped further
                         by tenant for tenant-shared resources like KB/MCP)
    """
    type: str                   # 'all' | 'tenant' | 'own'
    user_id: Optional[str] = None
    tenant_id: Optional[str] = None

    @property
    def is_all(self) -> bool:
        return self.type == "all"


def get_data_scope(user: UserInDB = Depends(current_user)) -> "DataScope":
    """Resolve the caller's data visibility. Injected into list endpoints."""
    if user.role == "admin":
        return DataScope(type="all")
    if user.tenant_id and user.role == "tenant_admin":
        return DataScope(type="tenant", user_id=user.id, tenant_id=user.tenant_id)
    if user.tenant_id:
        # member: tenant-scoped for shared resources, own-only for sessions/schedules
        return DataScope(type="own", user_id=user.id, tenant_id=user.tenant_id)
    # Legacy user with no tenant — keep old behaviour (own data only).
    return DataScope(type="own", user_id=user.id, tenant_id=None)


# ── Feature permission dependencies ───────────────────────────────────────────

async def require_platform_access(user: UserInDB = Depends(current_user)) -> UserInDB:
    """Gate platform-level operations (create/configure tenants).

    The caller must be a member of the 'agentscope' platform tenant. Within
    that tenant, role 'admin' has full power; 'tenant_admin'/'user' members
    can still create and configure tenants (platform operators) but, per the
    model, cannot add users to *other* tenants — that's the other tenant's
    tenant_admin's job (enforced in tenant_router's member endpoints).
    """
    role = get_user_member_role(user.id, PLATFORM_TENANT_ID)
    if not role:
        logger.warning("platform access denied: user=%s not in agentscope tenant", user.id)
        raise HTTPException(403, detail="Platform operators only")
    return user


def require_feature(perm: str):
    """Return a FastAPI dependency that checks the user has `perm`.

    - admin → always pass
    - user with a tenant → pass iff perm in tenant.menu_permissions
    - legacy user (no tenant) → pass (preserves pre-migration behaviour)
    """
    async def dep(user: UserInDB = Depends(current_user)) -> UserInDB:
        if user.role == "admin":
            return user
        if not user.tenant_id:
            # Legacy non-admin: no tenant gating yet. Their UI visibility is
            # still controlled by the frontend's menu_permissions resolution
            # (workspace-only), but the API stays open for backward compat.
            return user
        tenant = get_tenant(user.tenant_id)
        if not tenant:
            logger.warning("user=%s has stale tenant_id=%s (not found)", user.id, user.tenant_id)
            raise HTTPException(403, "Tenant not found; contact an administrator")
        if perm not in tenant.menu_permissions:
            logger.warning("feature denied: user=%s perm=%s tenant=%s", user.id, perm, user.tenant_id)
            raise HTTPException(403, f"Feature '{perm}' is not enabled for your tenant")
        return user
    return dep


def require_resource_access(resource_type: str, param: str):
    """Return a dependency that checks a path param is in the tenant's pool.

    `resource_type` is one of: agents, mcps, skills, credentials.
    `param` is the FastAPI path parameter name carrying the resource id.
    Admin passes; a legacy user (no tenant) passes for backward compat.
    """
    async def dep(
        request,  # FastAPI Request — read path params by name
        user: UserInDB = Depends(current_user),
    ) -> UserInDB:
        if user.role == "admin":
            return user
        if not user.tenant_id:
            return user
        tenant = get_tenant(user.tenant_id)
        if not tenant:
            raise HTTPException(403, "Tenant not found; contact an administrator")
        pool = getattr(tenant, f"assigned_{resource_type}", [])
        resource_id = request.path_params.get(param)
        if resource_id is not None and resource_id not in pool:
            logger.warning(
                "resource denied: user=%s %s=%s tenant=%s",
                user.id, resource_type, resource_id, user.tenant_id,
            )
            raise HTTPException(403, f"{resource_type} '{resource_id}' is not assigned to your tenant")
        return user
    return dep
