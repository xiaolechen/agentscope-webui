"""Model configuration — user default model and credential custom model names."""
import time
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from auth_router import UserInDB, current_user, _r
from webui_helpers import ChatModelConfig, _get_json, _set_json, _get_list, _set_list, AGENTSCOPE_BASE, _forward_auth_headers

logger = logging.getLogger(__name__)

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


# ── Model connectivity test ───────────────────────────────────────────────────

_PROVIDER_DEFAULTS: dict[str, tuple[str, str]] = {
    # (default_base_url, auth_scheme)
    # auth_scheme: "bearer" | "x-api-key" | "ollama"
    "openai_credential":    ("https://api.openai.com/v1",                         "bearer"),
    "deepseek_credential":  ("https://api.deepseek.com/v1",                       "bearer"),
    "dashscope_credential": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "bearer"),
    "moonshot_credential":  ("https://api.moonshot.cn/v1",                        "bearer"),
    "xai_credential":       ("https://api.x.ai/v1",                               "bearer"),
    "anthropic_credential": ("https://api.anthropic.com/v1",                      "x-api-key"),
    "ollama_credential":    ("http://localhost:11434",                             "ollama"),
}


@router.post("/test-model")
async def test_model_connectivity(body: dict, request: Request, _: UserInDB = Depends(current_user)):
    credential_id = (body.get("credential_id") or "").strip()
    model_name    = (body.get("model_name") or "").strip()
    if not (credential_id and model_name):
        raise HTTPException(400, "credential_id and model_name required")

    fwd = _forward_auth_headers(request)
    async with httpx.AsyncClient(timeout=20) as client:
        cred_resp = await client.get(f"{AGENTSCOPE_BASE}/credential/{credential_id}", headers=fwd)
        if cred_resp.is_success:
            cred_data = cred_resp.json().get("data", {}) or {}
        else:
            list_resp = await client.get(f"{AGENTSCOPE_BASE}/credential/", headers=fwd)
            creds = list_resp.json().get("credentials", []) if list_resp.is_success else []
            cred_data = next((c["data"] for c in creds if c["id"] == credential_id), {})

        if not cred_data:
            raise HTTPException(404, "credential not found")

        cred_type = cred_data.get("type", "")
        api_key   = cred_data.get("api_key", "")
        default_url, scheme = _PROVIDER_DEFAULTS.get(cred_type, ("https://api.openai.com/v1", "bearer"))
        base_url  = cred_data.get("base_url") or cred_data.get("host") or default_url
        base_url  = base_url.rstrip("/")

        logger.info("test-model: cred=%s type=%s model=%s scheme=%s", credential_id[:8], cred_type, model_name, scheme)
        t0 = time.monotonic()
        try:
            if scheme == "ollama":
                r = await client.get(f"{base_url}/api/tags", timeout=10)
            elif scheme == "x-api-key":
                r = await client.post(
                    f"{base_url}/messages",
                    json={"model": model_name, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                    timeout=15,
                )
            else:
                r = await client.post(
                    f"{base_url}/chat/completions",
                    json={"model": model_name, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    timeout=15,
                )
            latency = int((time.monotonic() - t0) * 1000)
            if r.status_code < 300:
                return {"ok": True, "latency_ms": latency}
            return {"ok": False, "latency_ms": latency, "error": r.text[:200]}
        except httpx.TimeoutException:
            return {"ok": False, "error": "timeout"}
        except Exception as e:
            logger.error("test-model error: cred=%s %s", credential_id[:8], e)
            return {"ok": False, "error": str(e)[:200]}
