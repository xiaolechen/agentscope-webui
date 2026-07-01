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
    role: str  # "admin" | "user"
    bound_agent_ids: list[str] = []


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


def check_login_rate(ip: str) -> None:
    """Raise 429 once an IP exceeds LOGIN_MAX_ATTEMPTS within the window."""
    key = _login_rate_key(ip)
    r = _r()
    count = r.incr(key)
    if count == 1:
        r.expire(key, LOGIN_WINDOW_SECONDS)
    if count > LOGIN_MAX_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts. Please try again later.",
        )


def reset_login_rate(ip: str) -> None:
    """Clear the counter after a successful login (don't penalise success)."""
    _r().delete(_login_rate_key(ip))


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(data: dict) -> str:
    payload = {**data, "exp": datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _bootstrap_admin():
    """Create default admin on first run."""
    admin_pw = os.getenv("ADMIN_PASSWORD", "admin123")
    if admin_pw == "admin123":
        logger.warning(
            "ADMIN_PASSWORD is using the default 'admin123'. "
            "Change it in .env before production use."
        )
    if not get_user("admin"):
        user = UserInDB(
            id=str(uuid.uuid4()),
            username="admin",
            hashed_password=hash_password(admin_pw),
            role="admin",
        )
        save_user(user)


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
    except JWTError:
        raise exc
    user = get_user_by_id(uid)
    if not user:
        raise exc
    return user


async def admin_required(user: UserInDB = Depends(current_user)) -> UserInDB:
    if user.role != "admin":
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
    client_ip = request.client.host if request.client else "unknown"
    check_login_rate(client_ip)
    user = get_user(form.username)
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    reset_login_rate(client_ip)
    token = create_token({"sub": user.id, "role": user.role})
    return Token(access_token=token, token_type="bearer", role=user.role, user_id=user.id)


@router.get("/me")
async def me(user: UserInDB = Depends(current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "bound_agent_ids": user.bound_agent_ids,
    }
