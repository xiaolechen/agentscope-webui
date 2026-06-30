"""JWT auth + user management — shared helpers and /auth router."""
from datetime import datetime, timedelta
from typing import Optional
import json, logging, os, secrets, uuid

# Suppress passlib/bcrypt version-check warning (bcrypt 4.x removed __about__)
logging.getLogger("passlib.handlers.bcrypt").setLevel(logging.ERROR)

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

SECRET_KEY = os.getenv("JWT_SECRET", secrets.token_hex(32))
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


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_token(data: dict) -> str:
    payload = {**data, "exp": datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE_MINUTES)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _bootstrap_admin():
    """Create default admin on first run."""
    if not get_user("admin"):
        user = UserInDB(
            id=str(uuid.uuid4()),
            username="admin",
            hashed_password=hash_password(os.getenv("ADMIN_PASSWORD", "admin123")),
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


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/login", response_model=Token)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    user = get_user(form.username)
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
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
