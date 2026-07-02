"""User management router — admin-only CRUD with agent binding."""
import logging, uuid, json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth_router import UserInDB, admin_required, hash_password, save_user, get_user_by_id, _r

router = APIRouter(prefix="/users", tags=["users"])
logger = logging.getLogger(__name__)


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"
    bound_agent_ids: list[str] = []


class UpdateUserRequest(BaseModel):
    password: str | None = None
    role: str | None = None
    bound_agent_ids: list[str] | None = None


def list_all_users() -> list[UserInDB]:
    ids = _r().smembers("webui:users:all")
    users = []
    for uid in ids:
        data = _r().get(f"webui:user:id:{uid}")
        if data:
            users.append(UserInDB(**json.loads(data)))
    return users


@router.get("/", dependencies=[Depends(admin_required)])
async def list_users():
    return [
        {"id": u.id, "username": u.username, "role": u.role,
         "bound_agent_ids": u.bound_agent_ids}
        for u in list_all_users()
    ]


@router.post("/", status_code=201)
async def create_user(req: CreateUserRequest, admin: UserInDB = Depends(admin_required)):
    user = UserInDB(
        id=str(uuid.uuid4()),
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        bound_agent_ids=req.bound_agent_ids,
    )
    save_user(user)
    logger.info("admin=%s created user=%s role=%s", admin.username, user.username, user.role)
    return {"id": user.id, "username": user.username, "role": user.role}


@router.patch("/{user_id}")
async def update_user(user_id: str, req: UpdateUserRequest, admin: UserInDB = Depends(admin_required)):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    changed = list(req.model_dump(exclude_unset=True).keys())
    updates: dict = {}
    if req.password:
        updates["hashed_password"] = hash_password(req.password)
    if req.role:
        updates["role"] = req.role
    if req.bound_agent_ids is not None:
        updates["bound_agent_ids"] = req.bound_agent_ids
    user = user.model_copy(update=updates)
    save_user(user)
    logger.info("admin=%s updated user=%s fields=%s", admin.username, user.username, changed)
    return {"id": user.id, "username": user.username, "role": user.role,
            "bound_agent_ids": user.bound_agent_ids}


@router.delete("/{user_id}", status_code=204)
async def delete_user(user_id: str, admin: UserInDB = Depends(admin_required)):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    logger.info("admin=%s deleted user=%s role=%s", admin.username, user.username, user.role)
    r = _r()
    r.delete(f"webui:user:id:{user_id}", f"webui:user:name:{user.username}")
    r.srem("webui:users:all", user_id)
