"""Skill library — directory scanning, enable/disable, and install."""
import asyncio, logging, pathlib, shlex, shutil
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_router import UserInDB, admin_required, current_user
from webui_helpers import (
    _config_owner,
    _get_list, _set_list,
    _skill_dirs_key, _skill_disabled_key,
)

router = APIRouter(prefix="/webui", tags=["webui"])
logger = logging.getLogger(__name__)


class SkillDef(BaseModel):
    name: str
    path: str
    is_enabled: bool = True


# Shell metacharacters that must not appear anywhere in the raw install command.
# The parser reconstructs a safe argv list from individual tokens — the raw
# string is never passed to a shell — but rejecting these upfront provides an
# additional defence-in-depth layer.
_SKILL_INSTALL_FORBIDDEN = set(";|&$`()<>{}\n\r")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _scan_skills(dirs: list, disabled: set) -> list:
    """Scan each configured directory for subdirs containing SKILL.md.

    Skills are enabled by default; only paths present in ``disabled`` are off.
    Returns a list of {name, path, is_enabled} dicts sorted by directory order.
    """
    skills = []
    for d in dirs:
        p = pathlib.Path(d)
        if not p.is_dir():
            continue
        for subdir in sorted(p.iterdir()):
            if subdir.is_dir():
                skill_file = subdir / "SKILL.md"
                if skill_file.exists():
                    path_str = str(skill_file)
                    skills.append({
                        "name": subdir.name,
                        "path": path_str,
                        "is_enabled": path_str not in disabled,
                    })
    return skills


def _parse_skill_install_command(raw: str) -> list[str]:
    """Parse `npx skills add <url> --skill <name> [--force]` into a safe argv list.

    Never executes the raw string — extracts url and skill name, then rebuilds
    a controlled command. Rejects shell metacharacters and unrecognised flags.
    Raises HTTPException(400) on any deviation from the expected form.
    """
    if not raw or not raw.strip():
        raise HTTPException(400, "command is required")
    for ch in _SKILL_INSTALL_FORBIDDEN:
        if ch in raw:
            raise HTTPException(
                400,
                f"command contains forbidden character {ch!r}; "
                "only `npx skills add <url> --skill <name> [--force]` is supported.",
            )
    try:
        tokens = shlex.split(raw)
    except ValueError as e:
        raise HTTPException(400, f"could not parse command: {e}")

    if len(tokens) < 4 or tokens[0] != "npx" or tokens[1] != "skills" or tokens[2] != "add":
        raise HTTPException(
            400, "command must start with `npx skills add <url> --skill <name>`."
        )

    url: Optional[str] = None
    skill_name: Optional[str] = None
    force = False
    i = 3
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--skill":
            if i + 1 >= len(tokens):
                raise HTTPException(400, "--skill requires a value")
            skill_name = tokens[i + 1]
            i += 2
        elif tok == "--force":
            force = True
            i += 1
        elif tok.startswith("-"):
            raise HTTPException(400, f"unsupported flag {tok!r}")
        else:
            if url is not None:
                raise HTTPException(400, "only one source URL is allowed")
            url = tok
            i += 1

    if not url or not skill_name:
        raise HTTPException(400, "url and --skill <name> are required")
    if "/" in skill_name or "\\" in skill_name:
        raise HTTPException(400, "skill name must not contain path separators")

    cmd = ["npx", "--yes", "skills", "add", url, "--skill", skill_name]
    if force:
        cmd.append("--force")
    return cmd


def _ensure_skill_dir_registered(owner: str, dir_path: str) -> None:
    """Register a directory as a skill-dir for the config owner if not present."""
    dirs = _get_list(_skill_dirs_key(owner))
    if dir_path not in dirs:
        dirs.append(dir_path)
        _set_list(_skill_dirs_key(owner), dirs)


# ── Skill directory management (admin-only write) ─────────────────────────────

@router.get("/skill-dirs")
async def get_skill_dirs(user: UserInDB = Depends(current_user)):
    return _get_list(_skill_dirs_key(_config_owner(user)))


@router.post("/skill-dirs")
async def add_skill_dir(body: dict, user: UserInDB = Depends(admin_required)):
    """Register a filesystem path as a skill directory. Admin-only.

    Any authenticated user can read skill-dirs for their namespace, but only
    admins may register new ones. Unrestricted registration would allow any
    user to enumerate arbitrary filesystem paths via _scan_skills.
    """
    path = body.get("path", "").strip()
    if not path:
        raise HTTPException(400, "path required")
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    if path not in dirs:
        dirs.append(path)
        _set_list(_skill_dirs_key(owner), dirs)
    return dirs


@router.delete("/skill-dirs")
async def delete_skill_dir(body: dict, user: UserInDB = Depends(admin_required)):
    """Remove a registered skill directory. Admin-only (same rationale as POST)."""
    path = body.get("path", "").strip()
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    _set_list(_skill_dirs_key(owner), [d for d in dirs if d != path])
    return {"ok": True}


# ── Skill library ─────────────────────────────────────────────────────────────

@router.get("/skill-lib")
async def get_skill_lib(user: UserInDB = Depends(current_user)):
    """Scan registered skill directories and return discovered skills."""
    owner = _config_owner(user)
    dirs = _get_list(_skill_dirs_key(owner))
    disabled = set(_get_list(_skill_disabled_key(owner)))
    return _scan_skills(dirs, disabled)


@router.post("/skill-lib/toggle")
async def toggle_skill(body: dict, user: UserInDB = Depends(current_user)):
    """Enable or disable a specific skill by its SKILL.md path."""
    path = body.get("path", "").strip()
    is_enabled = body.get("is_enabled", True)
    if not path:
        raise HTTPException(400, "path required")
    owner = _config_owner(user)
    disabled = set(_get_list(_skill_disabled_key(owner)))
    if is_enabled:
        disabled.discard(path)
    else:
        disabled.add(path)
    _set_list(_skill_disabled_key(owner), list(disabled))
    return {"path": path, "is_enabled": is_enabled}


@router.post("/skill-lib/install")
async def install_skill(body: dict, user: UserInDB = Depends(admin_required)):
    """Install a skill via `npx skills add` into a registered skill-dir.

    Admin-only: npx runs on the backend host and writes content to shared disk
    which is injected into LLM prompts (cross-tenant prompt-injection / SSRF
    surface). The command is parsed and rebuilt — the raw string is never
    executed — so only `npx skills add <url> --skill <name> [--force]` is honoured.
    """
    target_dir = (body.get("target_dir") or "").strip()
    command = body.get("command") or ""

    owner = _config_owner(user)
    registered = _get_list(_skill_dirs_key(owner))
    if not target_dir:
        raise HTTPException(400, "target_dir is required")
    if target_dir not in registered:
        raise HTTPException(
            403,
            "target_dir must be one of your registered skill directories "
            "(configure them in Settings).",
        )
    target_path = pathlib.Path(target_dir)
    if not target_path.is_dir():
        raise HTTPException(400, f"target_dir does not exist: {target_dir}")

    cmd = _parse_skill_install_command(command)

    if not shutil.which("npx"):
        raise HTTPException(400, "npx not found on the backend host")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=target_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        proc.kill()  # type: ignore[union-attr]
        logger.error("skill install timeout: cmd=%s target=%s", " ".join(cmd), target_dir)
        return {"ok": False, "error": "Timed out after 120s", "stdout": "", "stderr": "", "skills": []}
    except FileNotFoundError:
        logger.error("skill install failed: npx not found target=%s", target_dir)
        return {"ok": False, "error": "npx not found on the backend host", "stdout": "", "stderr": "", "skills": []}

    stdout_s = stdout.decode("utf-8", errors="replace")
    stderr_s = stderr.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        tail = stderr_s.strip()[-400:] or stdout_s.strip()[-400:]
        logger.error("skill install failed: cmd=%s target=%s code=%d stderr=%s",
                     " ".join(cmd), target_dir, proc.returncode, stderr_s.strip()[-200:])
        return {
            "ok": False,
            "error": f"npx exited {proc.returncode}: {tail}",
            "stdout": stdout_s,
            "stderr": stderr_s,
            "skills": [],
        }

    discovered: list[dict] = []
    for skill_file in target_path.glob("**/SKILL.md"):
        parts = skill_file.relative_to(target_path).parts
        if any(seg in {".git", "node_modules"} for seg in parts):
            continue
        skill_dir = skill_file.parent
        scan_dir = str(skill_dir.parent)
        _ensure_skill_dir_registered(owner, scan_dir)
        discovered.append({"name": skill_dir.name, "path": str(skill_file)})

    return {"ok": True, "stdout": stdout_s, "stderr": stderr_s, "skills": discovered}
