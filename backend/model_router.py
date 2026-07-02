"""Model configuration — user default model and credential custom model names."""
from fastapi import APIRouter, Depends, HTTPException

from auth_router import UserInDB, current_user, _r
from webui_helpers import ChatModelConfig, _get_json, _set_json, _get_list, _set_list

router = APIRouter(prefix="/webui", tags=["webui"])


# ── User default model ────────────────────────────────────────────────────────

@router.get("/me/default-model")
async def get_default_model(user: UserInDB = Depends(current_user)):
    return _get_json(f"webui:config:default-model:{user.id}") or {}


@router.put("/me/default-model")
async def set_default_model(
    config: ChatModelConfig,
    user: UserInDB = Depends(current_user),
):
    _set_json(f"webui:config:default-model:{user.id}", config.model_dump())
    return config


@router.delete("/me/default-model", status_code=204)
async def delete_default_model(user: UserInDB = Depends(current_user)):
    _r().delete(f"webui:config:default-model:{user.id}")


# ── Credential custom model names ─────────────────────────────────────────────
# Stores user-defined model name lists per credential for the model selector UI.
# No ownership check: credentials have no bound_credential_ids in UserInDB yet,
# and these endpoints only store display metadata, not secrets.

@router.get("/cred-models/{cred_id}")
async def get_cred_models(cred_id: str, _: UserInDB = Depends(current_user)):
    return _get_list(f"webui:config:cred-models:{cred_id}")


@router.post("/cred-models/{cred_id}")
async def add_cred_model(cred_id: str, body: dict, _: UserInDB = Depends(current_user)):
    model_name = body.get("model", "").strip()
    if not model_name:
        raise HTTPException(400, "model name required")
    models = _get_list(f"webui:config:cred-models:{cred_id}")
    if model_name not in models:
        models.append(model_name)
        _set_list(f"webui:config:cred-models:{cred_id}", models)
    return models


@router.delete("/cred-models/{cred_id}/{model_name}", status_code=204)
async def delete_cred_model(
    cred_id: str,
    model_name: str,
    _: UserInDB = Depends(current_user),
):
    models = _get_list(f"webui:config:cred-models:{cred_id}")
    _set_list(f"webui:config:cred-models:{cred_id}", [m for m in models if m != model_name])
