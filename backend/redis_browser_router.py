"""Read-only Redis data browser router (admin only).

Exposes two endpoints under /webui/redis for the Settings → Redis tab:
  - GET /webui/redis/keys   : SCAN keys by pattern, cursor-based paging
  - GET /webui/redis/key    : read a single key's first N elements by type

Strictly read-only: no SET/DEL/FLUSH/etc. is imported or callable here.
Reuses the shared sync redis client `_r()` from auth_router (localhost:6379,
decode_responses=True) — same instance agentscope-webui already reads/writes.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth_router import UserInDB, current_user, _r

router = APIRouter(prefix="/webui/redis", tags=["redis-browser"])

# ── Limits ────────────────────────────────────────────────────────────────────
MAX_PREVIEW = 100          # hard cap on rows returned per request
DEFAULT_PAGE = 20          # default page size the UI requests
MAX_VALUE_LEN = 4096       # truncate oversized string values for display
SCAN_COUNT = 200           # SCAN hint per call


def _require_admin(user: UserInDB) -> None:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


def _trunc(value: str) -> tuple[str, bool]:
    """Truncate a string value to MAX_VALUE_LEN, reporting whether it was cut."""
    if value is None:
        return ("", False)
    s = str(value)
    if len(s) > MAX_VALUE_LEN:
        return (s[:MAX_VALUE_LEN], True)
    return (s, False)


def _size(r, key: str, t: str) -> Optional[int]:
    if t == "string":
        return r.strlen(key)
    if t == "list":
        return r.llen(key)
    if t == "set":
        return r.scard(key)
    if t == "hash":
        return r.hlen(key)
    if t == "zset":
        return r.zcard(key)
    if t == "stream":
        return r.xlen(key)
    return None


def _rows(r, key: str, t: str, limit: int, offset: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if t == "string":
        v = r.get(key)
        text, truncated = _trunc(v)
        rows.append({"field": "(value)", "value": text, "truncated": truncated})
    elif t == "list":
        items = r.lrange(key, offset, offset + limit - 1)
        for i, x in enumerate(items, start=offset):
            text, truncated = _trunc(x)
            rows.append({"field": str(i), "value": text, "truncated": truncated})
    elif t == "set":
        # Sets have no native offset; webui sets are small. Sort for stable paging.
        members = sorted(r.smembers(key))
        for m in members[offset:offset + limit]:
            text, truncated = _trunc(m)
            rows.append({"field": "", "value": text, "truncated": truncated})
    elif t == "hash":
        pairs = r.hgetall(key)
        items = list(pairs.items())[offset:offset + limit]
        for f, v in items:
            text, truncated = _trunc(v)
            rows.append({"field": f, "value": text, "truncated": truncated})
    elif t == "zset":
        items = r.zrange(key, offset, offset + limit - 1, withscores=True)
        for m, score in items:
            text, truncated = _trunc(m)
            rows.append({"field": str(score), "value": text, "truncated": truncated})
    elif t == "stream":
        # xrange is id-based; approximate paging by count from the start.
        items = r.xrange(key, count=offset + limit)[offset:offset + limit] \
            if offset > 0 else r.xrange(key, count=limit)
        for mid, fields in items:
            text, truncated = _trunc(str(fields))
            rows.append({"field": str(mid), "value": text, "truncated": truncated})
    return rows


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/keys")
async def list_keys(
    user: UserInDB = Depends(current_user),
    cursor: int = Query(0, ge=0),
    pattern: str = Query("*"),
    count: int = Query(SCAN_COUNT, ge=1, le=1000),
):
    """SCAN keys matching `pattern`. Cursor-based: returns next cursor + done flag.

    SCAN may return empty batches even when not done; loop until we get keys
    or the scan completes, so a page is never pointlessly empty.
    """
    _require_admin(user)
    r = _r()
    cur = cursor
    items: list[dict[str, Any]] = []
    for _ in range(10):
        cur, keys = r.scan(cursor=cur, match=pattern, count=count)
        for k in keys:
            items.append({"key": k, "type": r.type(k), "ttl": r.ttl(k)})
        if items or cur == 0:
            break
    return {
        "cursor": cur,
        "done": cur == 0,
        "keys": items,
    }


@router.get("/key")
async def read_key(
    user: UserInDB = Depends(current_user),
    key: str = Query(...),
    limit: int = Query(DEFAULT_PAGE, ge=1, le=MAX_PREVIEW),
    offset: int = Query(0, ge=0),
):
    """Read up to `limit` elements of `key` starting at `offset`, by Redis type."""
    _require_admin(user)
    r = _r()
    t = r.type(key)
    if t == "none":
        raise HTTPException(status_code=404, detail="Key not found")
    return {
        "key": key,
        "type": t,
        "ttl": r.ttl(key),
        "size": _size(r, key, t),
        "rows": _rows(r, key, t, limit, offset),
    }
