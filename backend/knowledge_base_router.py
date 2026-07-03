"""Knowledge Base library — CRUD, file management, and llm-wiki-agent chat.

Each knowledge base is a directory on disk (default under LLM_WIKI_PATH) with a
``row/`` folder for source Markdown files and an ``index/`` folder for the
vector index built by the llm-wiki-agent. KB configs are stored in Redis,
scoped by ``_config_owner`` (admins share the ``admin`` namespace; non-admins
are isolated by user.id) — mirroring the MCP/Skill library pattern.

Chat with a KB goes through the agentscope native chat mechanism: a session is
created for the ``llm-wiki-agent`` agent and the user's question is forwarded
to ``/chat/`` with the KB path injected as context. The frontend connects to
the SSE stream directly, exactly like the main ChatPage.
"""
import json, logging, os, re, uuid
from typing import Optional

import httpx
from fastapi import (
    APIRouter, Depends, File, HTTPException, Request, UploadFile,
)
from pydantic import BaseModel, field_validator

from auth_router import UserInDB, current_user, _r
from webui_helpers import (
    AGENTSCOPE_BASE, LLM_WIKI_PATH,
    _config_owner, _get_json, _get_list, _set_list,
    _knowledge_base_key, _forward_auth_headers,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webui", tags=["webui"])

# KB names are used as directory names and Redis keys. Restrict to a safe
# charset to avoid path traversal and key collisions.
_KB_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]+$")

# The agentscope agent that backs KB init/build/chat. The user creates this
# agent and binds the llm-wiki skill to it.
LLM_WIKI_AGENT_NAME = "llm-wiki-agent"

# Files the editor is allowed to open/write. Uploads are restricted to the
# same set to keep the KB tidy for the indexer.
_EDITABLE_EXT = {".md", ".mdx", ".txt", ".markdown"}
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB

# SSE event types that signal the agent has finished its turn. Mirrors the
# frontend useSSEStream DONE_TYPES set.
_DONE_TYPES = {"REPLY_END", "EXCEED_MAX_ITERS"}


# ── Model ─────────────────────────────────────────────────────────────────────

class KnowledgeBase(BaseModel):
    name: str
    display_name: str = ""
    path: str
    auto_update: bool = False
    cron_expression: str = ""
    is_enabled: bool = True

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        v = v.strip()
        if not _KB_NAME_RE.fullmatch(v):
            raise ValueError(
                "KB name must match [a-zA-Z0-9_-]+ (letters, digits, "
                "underscore, hyphen). It is used as a directory name."
            )
        return v


class KnowledgeBaseCreate(BaseModel):
    """Creation payload — ``path`` is optional; defaults to LLM_WIKI_PATH/{owner}/{name}."""
    name: str
    display_name: str = ""
    path: str = ""
    auto_update: bool = False
    cron_expression: str = ""

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        v = v.strip()
        if not _KB_NAME_RE.fullmatch(v):
            raise ValueError(
                "KB name must match [a-zA-Z0-9_-]+ (letters, digits, "
                "underscore, hyphen)."
            )
        return v


class KnowledgeBaseUpdate(BaseModel):
    display_name: str = ""
    auto_update: bool = False
    cron_expression: str = ""


class FileWriteBody(BaseModel):
    path: str
    content: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _default_kb_path(owner: str, name: str) -> str:
    return os.path.join(LLM_WIKI_PATH, owner, name)


def _find_kb(owner: str, name: str) -> Optional[dict]:
    return next(
        (kb for kb in _get_list(_knowledge_base_key(owner)) if kb.get("name") == name),
        None,
    )


def _save_kb_list(owner: str, kbs: list[dict]) -> None:
    _set_list(_knowledge_base_key(owner), kbs)


def _resolve_kb_path(kb: dict) -> str:
    """Return the absolute on-disk path for a KB config dict."""
    return os.path.abspath(os.path.expanduser(kb["path"]))


def _safe_rel_path(kb_root: str, rel: str) -> str:
    """Join ``rel`` under ``kb_root`` and verify the result stays inside it.

    Rejects absolute paths, ``..`` traversal, and symlink escapes. The
    returned path is always inside ``kb_root``.
    """
    if not rel:
        raise HTTPException(400, "file path required")
    # Normalize and strip any leading slashes so it can't be treated as absolute.
    cleaned = rel.strip().lstrip("/")
    full = os.path.abspath(os.path.join(kb_root, cleaned))
    root_abs = os.path.abspath(kb_root)
    # Ensure the resolved path is within the KB root (traversal guard).
    if full != root_abs and not full.startswith(root_abs + os.sep):
        raise HTTPException(400, "path traversal denied")
    # Reject symlinks that point outside the KB root.
    if os.path.islink(full):
        real = os.path.realpath(full)
        if real != root_abs and not real.startswith(root_abs + os.sep):
            raise HTTPException(400, "symlink escape denied")
    return full


def _require_kb_access(owner: str, name: str) -> dict:
    """Look up a KB by name within an owner's namespace or 404."""
    kb = _find_kb(owner, name)
    if not kb:
        raise HTTPException(404, f"Knowledge base '{name}' not found")
    return kb


def _all_kb_owners() -> list[str]:
    """Every owner namespace that currently holds KB configs.

    Used so admins can see/operate KBs across all users (admin shared + each
    non-admin user's private namespace). Non-admins never call this — their
    access is enforced by ``_config_owner`` scoping them to their own id.
    """
    owners: set[str] = set()
    try:
        pattern = _knowledge_base_key("*")
        for key in _r().scan_iter(match=pattern, count=200):
            if isinstance(key, bytes):
                key = key.decode("utf-8", "ignore")
            # key = "webui:config:knowledge-base:{owner}"
            owner = key.split(":", 3)[-1]
            if owner:
                owners.add(owner)
    except Exception as e:
        logger.error("scan kb owners failed: %s", e)
    return list(owners)


def _resolve_kb_owner(user: UserInDB, name: str) -> str:
    """The owner namespace to use for an existing KB named ``name``.

    Admins can access any KB: search the shared admin namespace first, then
    every per-user namespace — first match wins. Non-admins are scoped to
    their own namespace (``_config_owner``), enforcing isolation. Callers
    that 404 when the KB isn't found still go through ``_require_kb_access``.
    """
    if user.role != "admin":
        return _config_owner(user)
    if _find_kb("admin", name):
        return "admin"
    for owner in _all_kb_owners():
        if owner == "admin":
            continue
        if _find_kb(owner, name):
            return owner
    return "admin"  # not found anywhere; _require_kb_access will raise 404


# ── CRUD endpoints ────────────────────────────────────────────────────────────

@router.get("/knowledge-base")
async def list_knowledge_bases(user: UserInDB = Depends(current_user)):
    """List KBs visible to the caller.

    Admins see **every** KB — the shared admin namespace plus each non-admin
    user's private namespace. Non-admins see only their own. Names are deduped
    (admin namespace wins on collision) so the frontend's by-name keying stays
    stable.
    """
    if user.role != "admin":
        return _get_list(_knowledge_base_key(_config_owner(user)))
    seen: dict[str, dict] = {}
    for owner in ["admin", *_all_kb_owners()]:
        for kb in _get_list(_knowledge_base_key(owner)):
            name = kb.get("name")
            if name and name not in seen:
                seen[name] = kb
    return list(seen.values())


@router.post("/knowledge-base")
async def create_knowledge_base(
    body: KnowledgeBaseCreate,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    owner = _config_owner(user)
    kbs = _get_list(_knowledge_base_key(owner))
    if any(kb.get("name") == body.name for kb in kbs):
        raise HTTPException(409, f"Knowledge base '{body.name}' already exists")

    path = body.path.strip() or _default_kb_path(owner, body.name)
    path = os.path.abspath(os.path.expanduser(path))

    # Ensure the KB root directory exists. The llm-wiki-agent creates the full
    # my-llm-wiki standard structure (raw/, entities/, SCHEMA.md, index.md, …)
    # during init — we deliberately do NOT pre-create any subdirs here, since
    # hardcoding row/ + index/ + config.json would leave stale legacy artifacts
    # alongside the agent's output.
    os.makedirs(path, exist_ok=True)

    kb = KnowledgeBase(
        name=body.name,
        display_name=body.display_name,
        path=path,
        auto_update=body.auto_update,
        cron_expression=body.cron_expression,
        is_enabled=True,
    )
    kbs.append(kb.model_dump())
    _save_kb_list(owner, kbs)
    logger.info("KB created: name=%s owner=%s path=%s user=%s",
                body.name, owner, path, user.username)

    # Auto-initialize via the llm-wiki-agent. If the agent doesn't exist yet,
    # the KB is still saved — the frontend surfaces the message prompting the
    # user to create it, and they can re-init later via the build endpoint.
    init_prompt = (
        f"[知识库路径: {path}]\n\n"
        "请按 my-llm-wiki skill 的「Initializing a New Wiki」流程初始化这个知识库。\n"
        "这是无人值守的自动初始化，不要询问用户任何问题，按以下要求完成：\n"
        "1. 创建目录结构：raw/{articles,papers,transcripts,assets}、entities/、concepts/、"
        "comparisons/、queries/。\n"
        "2. 写入 SCHEMA.md（使用通用领域占位，用户后续可编辑）。\n"
        "3. 写入初始 index.md（分区头部：Entities/Concepts/Comparisons/Queries）。\n"
        "4. 写入初始 log.md（含一条 create 记录）。\n"
        "5. 不要 ingest 任何来源，只创建空骨架。\n"
        "完成后简短报告已创建的文件。"
    )
    init = await _trigger_agent_action(
        request, user, path, init_prompt, f"kb-init-{body.name}", timeout=180,
    )
    return {**kb.model_dump(), "init": init}


@router.put("/knowledge-base/{name}")
async def update_knowledge_base(
    name: str,
    body: KnowledgeBaseUpdate,
    user: UserInDB = Depends(current_user),
):
    """Update editable KB fields. ``name`` and ``path`` are immutable."""
    owner = _resolve_kb_owner(user, name)
    kbs = _get_list(_knowledge_base_key(owner))
    raw = _find_kb(owner, name)
    if not raw:
        raise HTTPException(404, f"Knowledge base '{name}' not found")
    updated = {
        **raw,
        "display_name": body.display_name,
        "auto_update": body.auto_update,
        "cron_expression": body.cron_expression,
    }
    _save_kb_list(owner, [updated if kb.get("name") == name else kb for kb in kbs])
    return updated


@router.patch("/knowledge-base/{name}")
async def toggle_knowledge_base(
    name: str,
    body: dict,
    user: UserInDB = Depends(current_user),
):
    owner = _resolve_kb_owner(user, name)
    kbs = _get_list(_knowledge_base_key(owner))
    raw = _find_kb(owner, name)
    if not raw:
        raise HTTPException(404, f"Knowledge base '{name}' not found")
    updated = {
        **raw,
        "is_enabled": body.get("is_enabled", raw.get("is_enabled", True)),
    }
    _save_kb_list(owner, [updated if kb.get("name") == name else kb for kb in kbs])
    return updated


@router.delete("/knowledge-base/{name}", status_code=204)
async def delete_knowledge_base(
    name: str,
    user: UserInDB = Depends(current_user),
):
    owner = _resolve_kb_owner(user, name)
    kbs = _get_list(_knowledge_base_key(owner))
    raw = _find_kb(owner, name)
    if not raw:
        return  # idempotent delete
    _save_kb_list(owner, [kb for kb in kbs if kb.get("name") != name])
    # Leave the on-disk directory in place — deletion is reversible only by
    # re-registering the path. Admins can clean up manually if needed.
    logger.info("KB deleted: name=%s owner=%s user=%s", name, owner, user.username)


# ── File system endpoints ─────────────────────────────────────────────────────

@router.get("/knowledge-base/{name}/files")
async def list_files(name: str, user: UserInDB = Depends(current_user)):
    """Return a recursive file tree rooted at the KB directory.

    The KB root is the tree root so the user sees the full my-llm-wiki structure
    (``raw/``, ``entities/``, ``concepts/``, ``SCHEMA.md``, ``index.md``, …).
    All files and directories are listed — including empty directories and
    non-markdown files — so the user can browse the whole KB. The editor only
    lets you *edit* text files, but you can still see (and read) everything.
    ``.git`` internals are skipped to keep the tree clean.
    """
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_root = _resolve_kb_path(kb)
    if not os.path.isdir(kb_root):
        return []

    def build_tree(dir_path: str) -> list[dict]:
        nodes: list[dict] = []
        try:
            entries = sorted(os.listdir(dir_path))
        except OSError:
            return nodes
        for entry in entries:
            # Skip .git internals — they're noise in the file tree.
            if entry == ".git":
                continue
            full = os.path.join(dir_path, entry)
            rel = os.path.relpath(full, kb_root)
            if os.path.isdir(full):
                nodes.append({
                    "name": entry, "path": rel,
                    "type": "directory", "children": build_tree(full),
                })
            elif os.path.isfile(full):
                nodes.append({"name": entry, "path": rel, "type": "file"})
        return nodes

    return build_tree(kb_root)


@router.get("/knowledge-base/{name}/files/read")
async def read_file(name: str, file: str, user: UserInDB = Depends(current_user)):
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_root = _resolve_kb_path(kb)
    full = _safe_rel_path(kb_root, file)
    if not os.path.isfile(full):
        raise HTTPException(404, f"File '{file}' not found")
    try:
        with open(full, "r", encoding="utf-8") as f:
            content = f.read()
    except UnicodeDecodeError:
        # Binary or non-UTF-8 file (e.g. an image in assets/). The tree shows
        # it for browsing, but the editor can't display it as text.
        raise HTTPException(415, f"'{file}' is a binary file and can't be previewed as text")
    except OSError as e:
        logger.error("KB read failed: kb=%s file=%s error=%s", name, file, e)
        raise HTTPException(500, f"Failed to read file: {e}")
    return {"path": file, "content": content}


@router.put("/knowledge-base/{name}/files/write")
async def write_file(
    name: str,
    body: FileWriteBody,
    user: UserInDB = Depends(current_user),
):
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_root = _resolve_kb_path(kb)
    full = _safe_rel_path(kb_root, body.path)
    # Only allow editing text files the indexer recognises.
    if os.path.splitext(full)[1].lower() not in _EDITABLE_EXT:
        raise HTTPException(400, "only .md/.mdx/.txt files are editable")
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(body.content)
    except OSError as e:
        logger.error("KB write failed: kb=%s file=%s error=%s", name, body.path, e)
        raise HTTPException(500, f"Failed to write file: {e}")
    logger.info("KB file saved: kb=%s file=%s user=%s", name, body.path, user.username)
    return {"ok": True, "path": body.path}


@router.delete("/knowledge-base/{name}/files/delete", status_code=204)
async def delete_file(
    name: str,
    file: str,
    user: UserInDB = Depends(current_user),
):
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_root = _resolve_kb_path(kb)
    full = _safe_rel_path(kb_root, file)
    if os.path.isfile(full):
        try:
            os.remove(full)
            logger.info("KB file deleted: kb=%s file=%s user=%s", name, file, user.username)
        except OSError as e:
            logger.error("KB delete failed: kb=%s file=%s error=%s", name, file, e)
            raise HTTPException(500, f"Failed to delete file: {e}")


@router.post("/knowledge-base/{name}/files/upload")
async def upload_file(
    name: str,
    request: Request,
    file: UploadFile = File(...),
    user: UserInDB = Depends(current_user),
):
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_root = _resolve_kb_path(kb)

    filename = os.path.basename(file.filename or "upload.md")
    if os.path.splitext(filename)[1].lower() not in _EDITABLE_EXT:
        raise HTTPException(400, "only .md/.mdx/.txt files can be uploaded")

    full = _safe_rel_path(kb_root, os.path.join("raw", filename))
    content = await file.read()
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file too large (max {_MAX_UPLOAD_BYTES // (1024*1024)} MB)")
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "wb") as f:
            f.write(content)
    except OSError as e:
        logger.error("KB upload failed: kb=%s file=%s error=%s", name, filename, e)
        raise HTTPException(500, f"Failed to save file: {e}")
    logger.info("KB file uploaded: kb=%s file=%s user=%s", name, filename, user.username)
    return {"ok": True, "path": filename}


# ── llm-wiki-agent session & chat ─────────────────────────────────────────────

async def _find_llm_wiki_agent_id(request: Request) -> Optional[str]:
    """Return the llm-wiki-agent's agent_id, or None if it hasn't been created.

    Non-raising so callers that want to degrade gracefully (e.g. KB creation)
    can surface a friendly message instead of erroring.
    """
    headers = _forward_auth_headers(request)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{AGENTSCOPE_BASE}/agent/", headers=headers)
    except Exception as e:
        logger.error("agent list request failed: %s", e)
        return None
    if not resp.is_success:
        logger.error("agent list failed: status=%d body=%s", resp.status_code, resp.text[:200])
        return None
    for agent in resp.json().get("agents", []):
        if (agent.get("data") or {}).get("name") == LLM_WIKI_AGENT_NAME:
            return agent["id"]
    return None


_AGENT_NOT_FOUND_MSG = (
    f"Agent '{LLM_WIKI_AGENT_NAME}' not found. Please create an agent named "
    f"'{LLM_WIKI_AGENT_NAME}' and bind the llm-wiki skill to it first."
)


async def _find_llm_wiki_agent(request: Request) -> str:
    """Find the llm-wiki-agent's agent_id. 404 if the user hasn't created it."""
    aid = await _find_llm_wiki_agent_id(request)
    if not aid:
        raise HTTPException(404, _AGENT_NOT_FOUND_MSG)
    return aid


async def _trigger_agent_action(
    request: Request,
    user: UserInDB,
    kb_path: str,
    prompt: str,
    session_name: str,
    timeout: int = 180,
) -> dict:
    """Find the llm-wiki-agent, create a one-shot session, send ``prompt``,
    and **wait for the agent to finish** by draining the SSE stream.

    Used for KB init (on creation) and build. Returns ``{ok, error?, session_id?}``:
      - ``ok=True`` — agent ran to completion (received REPLY_END / EXCEED_MAX_ITERS)
      - ``ok=False, error="agent_not_found"`` — the llm-wiki-agent doesn't exist
      - ``ok=False, error="no_model_config"`` — agent has no model configured
      - ``ok=False, error=<detail>`` — session/chat call failed, or the stream
        ended/timed out before the agent finished

    Never raises — callers fold the result into their response so the KB record
    is always persisted even if the agent isn't ready yet.

    Why drain the stream: POSTing to ``/chat/`` only *triggers* the agent; the
    real work (creating files, running git, building the index) happens
    asynchronously. Returning ``ok`` as soon as the trigger is accepted leaves
    the KB half-initialized — the user sees an empty tree because the agent
    hadn't finished writing files yet. We must block until the agent signals
    completion.

    Session preparation mirrors the ChatPage send sequence (CLAUDE.md decisions
    #2–#3): PATCH the session with the agent's ``chat_model_config`` (without it
    agentscope accepts the trigger but silently produces an empty stream), then
    inject the agent's bound skills/MCPs + permission_mode via the
    ``/webui/session-workspace`` endpoint. Skipping either step leaves the agent
    unable to run or unaware of the my-llm-wiki procedure.
    """
    agent_id = await _find_llm_wiki_agent_id(request)
    if not agent_id:
        return {"ok": False, "error": "agent_not_found"}

    headers = _forward_auth_headers(request)
    full_prompt = f"[知识库路径: {kb_path}]\n\n{prompt}"
    try:
        # 0. Resolve the agent's model config (agent-scoped, fall back to the
        #    user's default). Without chat_model_config the chat trigger is
        #    accepted (200) but the stream is empty — a silent 180s hang.
        model_cfg = _get_json(f"webui:config:agent-model:{agent_id}") \
            or _get_json(f"webui:config:default-model:{user.id}")
        if not model_cfg:
            logger.warning("KB init skipped (no model): agent=%s user=%s",
                           agent_id, user.username)
            return {"ok": False, "error": "no_model_config"}

        async with httpx.AsyncClient(timeout=30) as client:
            # 1. Create session.
            sresp = await client.post(
                f"{AGENTSCOPE_BASE}/sessions/",
                json={"agent_id": agent_id, "name": session_name},
                headers=headers,
            )
            if not sresp.is_success:
                return {"ok": False, "error": f"session create failed ({sresp.status_code})"}
            session_id = sresp.json().get("session_id")
            if not session_id:
                return {"ok": False, "error": "backend returned no session_id"}

            # 2. PATCH chat_model_config so the agent can actually call its LLM.
            mresp = await client.patch(
                f"{AGENTSCOPE_BASE}/sessions/{session_id}",
                params={"agent_id": agent_id},
                json={"chat_model_config": model_cfg},
                headers=headers,
            )
            if not mresp.is_success:
                logger.warning("KB session model PATCH failed: agent=%s session=%s status=%d body=%s",
                               agent_id, session_id, mresp.status_code, mresp.text[:200])
                return {"ok": False, "error": f"model config PATCH failed ({mresp.status_code})"}

        # 3. Inject the agent's bound skills/MCPs + permission_mode. This is a
        #    self-call to the webui session-workspace endpoint, which forwards
        #    the same JWT to the agentscope /workspace/* endpoints. The
        #    my-llm-wiki skill must be injected here or the agent won't know
        #    the wiki init procedure.
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                wresp = await client.post(
                    f"{AGENTSCOPE_BASE}/webui/session-workspace",
                    json={
                        "agent_id": agent_id,
                        "session_id": session_id,
                        "disabled_skill_paths": [],
                    },
                    headers=headers,
                )
            if not wresp.is_success:
                logger.warning("KB session-workspace failed: agent=%s session=%s status=%d body=%s",
                               agent_id, session_id, wresp.status_code, wresp.text[:200])
                return {"ok": False, "error": f"workspace inject failed ({wresp.status_code})"}
        except Exception as e:
            logger.error("KB session-workspace error: agent=%s session=%s error=%s",
                         agent_id, session_id, e)
            return {"ok": False, "error": f"workspace inject error: {e}"}

        # 4. Trigger chat.
        async with httpx.AsyncClient(timeout=30) as client:
            cresp = await client.post(
                f"{AGENTSCOPE_BASE}/chat/",
                json={
                    "agent_id": agent_id,
                    "session_id": session_id,
                    "input": _build_user_msg(full_prompt),
                },
                headers=headers,
            )
            if not cresp.is_success:
                logger.warning("agent action failed: kb_path=%s status=%d body=%s",
                               kb_path, cresp.status_code, cresp.text[:200])
                return {"ok": False, "error": f"chat failed ({cresp.status_code})"}

        # 5. Block on the SSE stream until the agent finishes. Auto-confirm any
        #    tool permission requests so the agent can run autonomously.
        completed = await _drain_stream_until_done(session_id, agent_id, headers, timeout)
        if not completed:
            return {"ok": False, "error": "agent did not complete (stream ended or timed out)"}
    except httpx.TimeoutException:
        return {"ok": False, "error": f"timed out after {timeout}s"}
    except Exception as e:
        logger.error("agent action error: kb_path=%s error=%s", kb_path, e)
        return {"ok": False, "error": str(e)}
    return {"ok": True, "session_id": session_id, "agent_id": agent_id}


async def _drain_stream_until_done(
    session_id: str, agent_id: str, headers: dict, timeout: int,
) -> bool:
    """Connect to the session's SSE stream, auto-confirm tool permission
    requests, and wait until the agent signals end-of-turn.

    Returns ``True`` if a ``REPLY_END`` / ``EXCEED_MAX_ITERS`` event was
    received, ``False`` if the stream closed or errored first.
    """
    stream_url = f"{AGENTSCOPE_BASE}/sessions/{session_id}/stream?agent_id={agent_id}"
    # read timeout = the full budget; the agent may be silent for long stretches
    # while running bash/git. Connect timeout stays short.
    stream_timeout = httpx.Timeout(timeout, connect=15.0)
    try:
        async with httpx.AsyncClient(timeout=stream_timeout) as client:
            async with client.stream("GET", stream_url, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    logger.warning("stream failed: status=%d body=%s",
                                   resp.status_code, body[:200])
                    return False
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    try:
                        event = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    etype = event.get("type", "")
                    if etype in _DONE_TYPES:
                        return True
                    if etype == "REQUIRE_USER_CONFIRM":
                        await _auto_confirm_tool_calls(
                            client, agent_id, session_id, event, headers,
                        )
    except httpx.TimeoutException:
        logger.warning("stream timed out after %ds: session=%s", timeout, session_id)
        return False
    except Exception as e:
        logger.warning("stream read error: session=%s error=%s", session_id, e)
        return False
    return False


async def _auto_confirm_tool_calls(
    client: httpx.AsyncClient,
    agent_id: str,
    session_id: str,
    event: dict,
    headers: dict,
) -> None:
    """Approve all pending tool calls so an unattended init/build can proceed.

    Mirrors the ChatPage frontend auto-confirm: the webui runs KB init/build
    in the background, so there's no user to click "approve". We approve every
    tool call the agent asks about.
    """
    tool_calls = event.get("tool_calls") or []
    confirm_results = [{"confirmed": True, "tool_call": tc} for tc in tool_calls]
    try:
        await client.post(
            f"{AGENTSCOPE_BASE}/chat/",
            json={
                "agent_id": agent_id,
                "session_id": session_id,
                "input": {
                    "type": "USER_CONFIRM_RESULT",
                    "reply_id": event.get("reply_id"),
                    "confirm_results": confirm_results,
                },
            },
            headers=headers,
        )
    except Exception as e:
        logger.warning("auto-confirm failed: session=%s error=%s", session_id, e)


@router.get("/knowledge-base/agent-id")
async def get_llm_wiki_agent_id(
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Return the llm-wiki-agent's agent_id so the frontend can hand off to
    the main ChatPage with that agent pre-selected. 404 if not created."""
    aid = await _find_llm_wiki_agent_id(request)
    if not aid:
        raise HTTPException(404, _AGENT_NOT_FOUND_MSG)
    return {"agent_id": aid, "agent_name": LLM_WIKI_AGENT_NAME}


def _kb_session_key(name: str, owner: str) -> str:
    return f"webui:kb-session:{owner}:{name}"


@router.post("/knowledge-base/{name}/session")
async def create_kb_session(
    name: str,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Create or reuse an agentscope session for chatting with a KB.

    The KB path is injected into the first user message so the llm-wiki-agent
    knows which knowledge base to query. Returns ``{session_id, agent_id}``
    so the frontend can connect to the SSE stream directly.
    """
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    agent_id = await _find_llm_wiki_agent(request)
    kb_path = _resolve_kb_path(kb)

    # Reuse an existing session for this KB if one is already tracked.
    existing = _r_get(_kb_session_key(name, owner))
    if existing:
        return {"session_id": existing, "agent_id": agent_id, "kb_path": kb_path}

    headers = _forward_auth_headers(request)
    session_name = f"kb-{name}"
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{AGENTSCOPE_BASE}/sessions/",
            json={"agent_id": agent_id, "name": session_name},
            headers=headers,
        )
    if not resp.is_success:
        logger.warning("KB session create failed: kb=%s status=%d body=%s",
                       name, resp.status_code, resp.text[:200])
        raise HTTPException(resp.status_code, "Failed to create KB session")
    session_id = resp.json().get("session_id")
    if not session_id:
        raise HTTPException(502, "Backend returned no session_id")

    _r_set(_kb_session_key(name, owner), session_id)
    logger.info("KB session created: kb=%s session=%s user=%s", name, session_id, user.username)
    return {"session_id": session_id, "agent_id": agent_id, "kb_path": kb_path}


@router.post("/knowledge-base/{name}/chat")
async def chat_with_kb(
    name: str,
    body: dict,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Proxy a chat message to the llm-wiki-agent, injecting the KB path.

    The frontend triggers chat here, then connects to the SSE stream at
    ``/api/sessions/{sid}/stream?agent_id={aid}`` directly — same pattern as
    ChatPage. The KB path is prepended to the user's input so the agent's
    llm-wiki skill knows which knowledge base to检索.
    """
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    session_id = (body.get("session_id") or "").strip()
    message = (body.get("message") or "").strip()
    if not session_id:
        raise HTTPException(400, "session_id required")
    if not message:
        raise HTTPException(400, "message required")

    agent_id = await _find_llm_wiki_agent(request)
    kb_path = _resolve_kb_path(kb)

    # Prepend the KB path as context. The llm-wiki skill reads this to scope
    # its检索 to this knowledge base.
    prompt = f"[知识库路径: {kb_path}]\n\n{message}"

    headers = _forward_auth_headers(request)
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{AGENTSCOPE_BASE}/chat/",
            json={
                "agent_id": agent_id,
                "session_id": session_id,
                "input": _build_user_msg(prompt),
            },
            headers=headers,
        )
    if not resp.is_success:
        logger.warning("KB chat failed: kb=%s session=%s status=%d body=%s",
                       name, session_id, resp.status_code, resp.text[:200])
        raise HTTPException(resp.status_code, resp.text)
    return {"ok": True, "session_id": session_id, "agent_id": agent_id}


@router.post("/knowledge-base/{name}/build")
async def build_knowledge_base(
    name: str,
    request: Request,
    user: UserInDB = Depends(current_user),
):
    """Trigger the llm-wiki-agent to build/rebuild the KB index.

    Creates a one-shot session and asks the agent to build. The build itself
    happens inside the agent's llm-wiki skill.
    """
    owner = _resolve_kb_owner(user, name)
    kb = _require_kb_access(owner, name)
    kb_path = _resolve_kb_path(kb)
    result = await _trigger_agent_action(
        request, user, kb_path, "请构建/更新这个知识库的索引。", f"kb-build-{name}", timeout=300,
    )
    if result.get("ok"):
        logger.info("KB build triggered: kb=%s session=%s user=%s",
                    name, result.get("session_id"), user.username)
    else:
        logger.warning("KB build failed: kb=%s error=%s user=%s",
                       name, result.get("error"), user.username)
    return result


# ── Small Redis string helpers (KB session tracking) ─────────────────────────

def _r_get(key: str) -> Optional[str]:
    try:
        return _r().get(key)
    except Exception as e:
        logger.error("Redis read error key=%s: %s", key, e)
        return None


def _r_set(key: str, value: str) -> None:
    try:
        _r().set(key, value)
    except Exception as e:
        logger.error("Redis write error key=%s: %s", key, e)


def _build_user_msg(text: str) -> dict:
    """Build a Msg payload matching agentscope's /chat/ input schema.

    The endpoint validates ``input`` against a Msg model that requires ``id``
    and ``name`` fields (see ChatPage.buildUserMsg). Content blocks also need
    an ``id``. Both are generated as UUID4 strings.
    """
    block_id = str(uuid.uuid4())
    return {
        "id": str(uuid.uuid4()),
        "role": "user",
        "name": "user",
        "content": [{"type": "text", "text": text, "id": block_id}],
    }
