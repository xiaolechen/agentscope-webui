"""User management router — admin-only CRUD with agent binding."""
import uuid, json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth_router import UserInDB, admin_required, hash_password, save_user, get_user_by_id, _r

router = APIRouter(prefix="/users", tags=["users"])


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


@router.post("/", dependencies=[Depends(admin_required)], status_code=201)
async def create_user(req: CreateUserRequest):
    user = UserInDB(
        id=str(uuid.uuid4()),
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        bound_agent_ids=req.bound_agent_ids,
    )
    save_user(user)
    return {"id": user.id, "username": user.username, "role": user.role}


@router.patch("/{user_id}", dependencies=[Depends(admin_required)])
async def update_user(user_id: str, req: UpdateUserRequest):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if req.password:
        user.hashed_password = hash_password(req.password)
    if req.role:
        user.role = req.role
    if req.bound_agent_ids is not None:
        user.bound_agent_ids = req.bound_agent_ids
    save_user(user)
    return {"id": user.id, "username": user.username, "role": user.role,
            "bound_agent_ids": user.bound_agent_ids}


@router.delete("/{user_id}", dependencies=[Depends(admin_required)], status_code=204)
async def delete_user(user_id: str):
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found")
    r = _r()
    r.delete(f"webui:user:id:{user_id}", f"webui:user:name:{user.username}")
    r.srem("webui:users:all", user_id)
