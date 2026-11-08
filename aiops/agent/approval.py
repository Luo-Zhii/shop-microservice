"""Token duyệt/từ chối ký HMAC-SHA256: `<hết_hạn_epoch>.<hex(HMAC(secret, "id:decision:exp"))>`."""

from __future__ import annotations

import hashlib
import hmac
import time


def sign(secret: str, action_id: str, decision: str, ttl_s: int = 7200, now: float | None = None) -> str:
    exp = int((now or time.time()) + ttl_s)
    mac = hmac.new(secret.encode(), f"{action_id}:{decision}:{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{mac}"


def verify(secret: str, action_id: str, decision: str, token: str | None, now: float | None = None) -> bool:
    if not token or "." not in token:
        return False
    exp_s, _, mac = token.partition(".")
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    if exp < (now or time.time()):
        return False
    want = hmac.new(secret.encode(), f"{action_id}:{decision}:{exp}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, mac)
