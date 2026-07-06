"""JWT auth + user management — shared helpers and /auth router."""
from datetime import datetime, timedelta
from typing import Optional
import json, logging, os, secrets, uuid

# Suppress passlib/bcrypt version-check warning (bcrypt 4.x removed __about__)
logging.getLogger("passlib.handlers.bcrypt").setLevel(logging.ERROR)
logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

# Fail fast if JWT_SECRET is unset: a random per-restart secret would invalidate
# all tokens on every restart (and diverge across workers), silently logging out
# users. Generate one with: python -c "import secrets; print(secrets.token_hex(32))"
_jwt_secret = os.getenv("JWT_SECRET")
if not _jwt_secret:
    raise RuntimeError(
        "JWT_SECRET is not set. Add it to .env (generate with: "
        'python -c "import secrets; print(secrets.token_hex(32))"). '
        "Run 'bash setup.sh' to initialize, or see .env.example."
    )
SECRET_KEY = _jwt_secret
ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 1 week

pwd_context = CryptContext(schemes=["sha256_crypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")
router = APIRouter(prefix="/auth", tags=["auth"])


class Token(BaseModel):
    access_token: str
    token_type: str
    role: str
    user_id: str


class UserInDB(BaseModel):
    id: str
    username: str
    hashed_password: str
    role: str  # "admin" | "tenant_admin" | "user"
    bound_agent_ids: list[str] = []
    # Multi-tenant fields (Phase 1). admin has tenant_id=None; tenant_admin and
    # user carry the tenant they belong to. Defaults keep existing users valid.
    tenant_id: Optional[str] = None
    org_path: Optional[str] = None       # e.g. "技术部/后端组"
    permissions: list[str] = []          # reserved for fine-grained perm codes


# ── Redis helpers ────────────────────────────────────────────────────────────

def _r():
    import redis
    return redis.Redis(host="localhost", port=6379, decode_responses=True)


def get_user(username: str) -> Optional[UserInDB]:
    data = _r().get(f"webui:user:name:{username}")
    return UserInDB(**json.loads(data)) if data else None


def get_user_by_id(user_id: str) -> Optional[UserInDB]:
    data = _r().get(f"webui:user:id:{user_id}")
    return UserInDB(**json.loads(data)) if data else None


def save_user(user: UserInDB):
    r = _r()
    payload = user.model_dump_json()
    r.set(f"webui:user:name:{user.username}", payload)
    r.set(f"webui:user:id:{user.id}", payload)
    r.sadd("webui:users:all", user.id)


# ── Login rate limiting (Redis-backed) ────────────────────────────────────────
# Brute-force protection on /auth/login. Counts attempts per client IP within a
# fixed window; rejects with 429 once the threshold is exceeded.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_WINDOW_SECONDS = 60


def _login_rate_key(ip: str) -> str:
    return f"webui:login-rate:{ip}"


def _client_ip(request: Request) -> str:
    """Extract client IP, honouring X-Forwarded-For when TRUSTED_PROXY=true.

    When the backend is exposed behind a reverse proxy (BACKEND_HOST=0.0.0.0),
    request.client.host is the proxy's loopback address, making all users share
    one rate-limit bucket. Set TRUSTED_PROXY=true and ensure the proxy strips
    and re-adds X-Forwarded-For so it cannot be spoofed by clients.
    """
    if os.getenv("TRUSTED_PROXY", "").lower() in ("1", "true", "yes"):
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_login_rate(ip: str) -> None:
    """Raise 429 once an IP exceeds LOGIN_MAX_ATTEMPTS within the window.

    Uses a Redis pipeline so INCR and EXPIRE are sent atomically — without a
    pipeline, a crash between the two commands would leave the key without a
    TTL, permanently blocking the IP.
    """
    key = _login_rate_key(ip)
    r = _r()
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, LOGIN_WINDOW_SECONDS)
    count, _ = pipe.execute()
    if count > LOGIN_MAX_ATTEMPTS:
        logger.warning("login rate-limit hit: ip=%s count=%d", ip, count)
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please try again later.",
        )


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(data: dict) -> str:
    payload = {**data, "exp": datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _bootstrap_admin():
    """Create default admin + the platform 'agentscope' tenant on first run.

    The admin user is a member of the agentscope tenant with role 'admin'.
    """
    from webui_helpers import (
        Tenant, save_tenant, get_tenant, link_user_to_tenant,
        _tenant_members_key, _tenant_admins_key, PLATFORM_TENANT_ID,
        ALL_MENU_PERMS,
    )
    admin_pw = os.getenv("ADMIN_PASSWORD", "admin123")
    if admin_pw == "admin123":
        logger.warning(
            "ADMIN_PASSWORD is using the default 'admin123'. "
            "Change it in .env before production use."
        )
    # Ensure the platform tenant exists.
    if not get_tenant(PLATFORM_TENANT_ID):
        agentscope = Tenant(
            id=PLATFORM_TENANT_ID,
            name=PLATFORM_TENANT_ID,
            display_name="AgentScope",
            created_by="system",
            created_at=datetime.utcnow().isoformat() + "Z",
            menu_permissions=list(ALL_MENU_PERMS),
        )
        save_tenant(agentscope)
        logger.info("bootstrapped platform tenant=%s", PLATFORM_TENANT_ID)
    if not get_user("admin"):
        user = UserInDB(
            id=str(uuid.uuid4()),
            username="admin",
            hashed_password=hash_password(admin_pw),
            role="admin",
            tenant_id=PLATFORM_TENANT_ID,
        )
        save_user(user)
    else:
        # Existing admin (created before the v2 membership system) may lack
        # the platform-tenant membership and active context. Re-sync them.
        user = get_user("admin")
        if user.tenant_id != PLATFORM_TENANT_ID or user.role != "admin":
            user = user.model_copy(update={"tenant_id": PLATFORM_TENANT_ID, "role": "admin"})
            save_user(user)
    # Always ensure the admin's platform-tenant membership is registered,
    # even when the admin user already existed (idempotent migration).
    r = _r()
    pipe = r.pipeline()
    from webui_helpers import _user_memberships_key
    pipe.hset(_user_memberships_key(user.id), PLATFORM_TENANT_ID, "admin")
    pipe.set(f"webui:user:tenant:{user.id}", PLATFORM_TENANT_ID)
    pipe.sadd(_tenant_members_key(PLATFORM_TENANT_ID), user.id)
    pipe.sadd(_tenant_admins_key(PLATFORM_TENANT_ID), user.id)
    pipe.execute()


_bootstrap_admin()


# ── FastAPI dependencies ─────────────────────────────────────────────────────

async def current_user(token: str = Depends(oauth2_scheme)) -> UserInDB:
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        uid: str = payload.get("sub")
        if not uid:
            raise exc
    except JWTError as e:
        logger.warning("JWT decode failed: %s", e)
        raise exc
    user = get_user_by_id(uid)
    if not user:
        raise exc
    return user


async def admin_required(user: UserInDB = Depends(current_user)) -> UserInDB:
    if user.role != "admin":
        logger.warning("admin-required forbidden: user=%s", user.id)
        raise HTTPException(status_code=403, detail="Admin only")
    return user


# ── AgentScope native-endpoint auth override ─────────────────────────────────
# agentscope's get_current_user_id (agentscope/app/deps.py) only checks that the
# X-User-ID header is non-empty — anyone reachable on the port could supply it
# and read every credential / session / chat stream in the shared "webui"
# namespace (API keys are returned in plaintext). We override that dependency
# app-wide (see main.py) so a valid webui JWT is required. On success we return
# the shared namespace "webui" so agentscope's resource model (single shared
# namespace, webui RBAC layered on top in /webui/*) is preserved and the
# client-supplied X-User-ID header can no longer be spoofed.
async def webui_user_id(user: UserInDB = Depends(current_user)) -> str:
    """JWT-gated replacement for agentscope's get_current_user_id.

    Returns the shared namespace ``"webui"`` after verifying the caller's JWT.
    """
    return "webui"


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/login", response_model=Token)
async def login(request: Request, form: OAuth2PasswordRequestForm = Depends()):
    client_ip = _client_ip(request)
    check_login_rate(client_ip)
    user = get_user(form.username)
    if not user or not verify_password(form.password, user.hashed_password):
        logger.warning("login failed: username=%s ip=%s", form.username, client_ip)
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    # Do NOT reset the counter on success — deleting it would give an attacker a
    # fresh window after each successful login, allowing unlimited brute-force
    # attempts spread across sessions. Let the TTL expire naturally.

    # Resolve the active tenant from memberships. Prefer a platform/admin
    # membership, else the first membership; fall back to the legacy
    # user.tenant_id for pre-migration users with no membership record.
    from webui_helpers import get_user_memberships, PLATFORM_TENANT_ID, link_user_to_tenant
    memberships = get_user_memberships(user.id)
    active_tenant = user.tenant_id or ""
    active_role = user.role
    if memberships:
        if PLATFORM_TENANT_ID in memberships:
            active_tenant = PLATFORM_TENANT_ID
            active_role = memberships[PLATFORM_TENANT_ID]
        else:
            active_tenant = next(iter(memberships))
            active_role = memberships[active_tenant]
        # Persist the resolved active context so current_user reads it.
        user = user.model_copy(update={"tenant_id": active_tenant, "role": active_role})
        save_user(user)
    elif user.tenant_id:
        # Legacy user (created before the memberships HASH existed): backfill
        # the membership from the admin-set user.tenant_id/role so downstream
        # membership-based checks (e.g. _assert_can_manage_tenant) pass.
        link_user_to_tenant(user, user.tenant_id, user.role)
        memberships = get_user_memberships(user.id)

    token = create_token({
        "sub": user.id,
        "role": active_role,
        # tenant_id in JWT lets downstream resolvers skip a Redis lookup on the
        # hot path; empty string for a user with no tenant (legacy). Data-scope
        # / permission checks still read the live record from Redis for freshness.
        "tenant_id": active_tenant or "",
    })
    logger.info("login success: username=%s role=%s tenant=%s ip=%s",
                user.username, active_role, active_tenant or "-", client_ip)
    return Token(access_token=token, token_type="bearer", role=active_role, user_id=user.id)


@router.post("/switch-tenant", response_model=Token)
async def switch_tenant(target_tenant_id: str, user: UserInDB = Depends(current_user)):
    """Switch the caller's active tenant. Returns a fresh JWT carrying the new
    active tenant + the role the user holds *in that tenant*. The user must be
    a member of the target tenant."""
    from webui_helpers import get_user_member_role, get_tenant, PLATFORM_TENANT_ID
    # Detect platform admin via membership, not user.role — once an admin
    # switches into a regular tenant their active role becomes tenant_admin,
    # but they must still be able to switch back out and to other tenants.
    platform_role = get_user_member_role(user.id, PLATFORM_TENANT_ID)
    if platform_role == "admin":
        if not get_tenant(target_tenant_id):
            raise HTTPException(status_code=404, detail="Tenant not found")
        # In the platform tenant the admin keeps full admin role; in any
        # regular tenant they take on tenant_admin so they can verify that
        # tenant's menu permissions and resource assignments as its admin
        # would experience them.
        effective_role = "admin" if target_tenant_id == PLATFORM_TENANT_ID else "tenant_admin"
        updated = user.model_copy(update={"tenant_id": target_tenant_id, "role": effective_role})
        save_user(updated)
        token = create_token({
            "sub": user.id,
            "role": effective_role,
            "tenant_id": target_tenant_id,
        })
        logger.info("tenant switch (admin): user=%s -> tenant=%s role=%s",
                    user.username, target_tenant_id, effective_role)
        return Token(access_token=token, token_type="bearer", role=effective_role, user_id=user.id)
    # Non-admin: must be a member of the target tenant.
    role = get_user_member_role(user.id, target_tenant_id)
    if not role:
        raise HTTPException(status_code=403, detail="You are not a member of this tenant")
    # Persist the new active context so current_user reads it on later calls.
    updated = user.model_copy(update={"tenant_id": target_tenant_id, "role": role})
    save_user(updated)
    token = create_token({
        "sub": user.id,
        "role": role,
        "tenant_id": target_tenant_id,
    })
    logger.info("tenant switch: user=%s -> tenant=%s role=%s",
                user.username, target_tenant_id, role)
    return Token(access_token=token, token_type="bearer", role=role, user_id=user.id)


@router.get("/me")
async def me(user: UserInDB = Depends(current_user)):
    # Resolve menu permissions: admin = all; tenant members = tenant's list;
    # a user with no tenant (legacy) gets the workspace defaults so existing
    # non-admin logins keep seeing Chat/Sessions/Knowledge.
    from webui_helpers import (
        resolve_menu_permissions, get_user_memberships, get_tenant,
    )
    memberships = get_user_memberships(user.id)
    membership_view = []
    for tid, role in memberships.items():
        t = get_tenant(tid)
        membership_view.append({
            "tenant_id": tid,
            "role": role,
            "display_name": t.display_name if t else tid,
        })
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "bound_agent_ids": user.bound_agent_ids,
        "tenant_id": user.tenant_id,
        "active_tenant_id": user.tenant_id,
        "menu_permissions": resolve_menu_permissions(user),
        "memberships": membership_view,
    }
