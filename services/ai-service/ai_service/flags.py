"""Feature flag vận hành (cùng lược đồ flagd/OpenFeature với packages/platform/src/flags.ts):
đọc FLAGS_FILE (mặc định /etc/shopnow/flags/flags.json, ConfigMap do GitOps render), kiểm mtime ≤ 5s/lần, file hỏng giữ
bản tốt gần nhất, chưa đọc được → giá trị mặc định do code truyền."""

from __future__ import annotations

import json
import os
import threading
import time

_lock = threading.Lock()
_state: dict = {"path": None, "checked": 0.0, "mtime": None, "flags": None}
RELOAD_S = 5.0


def _load(now: float) -> dict | None:
    path = os.getenv("FLAGS_FILE", "/etc/shopnow/flags/flags.json")
    with _lock:
        if path != _state["path"]:
            _state.update(path=path, checked=0.0, mtime=None, flags=None)
        if now - _state["checked"] < RELOAD_S and _state["flags"] is not None:
            return _state["flags"]
        _state["checked"] = now
        try:
            m = os.stat(path).st_mtime
            if m != _state["mtime"] or _state["flags"] is None:
                data = json.loads(open(path, encoding="utf-8").read())
                if not isinstance(data.get("flags"), dict):
                    raise ValueError("thiếu khoá flags")
                _state.update(flags=data["flags"], mtime=m)
        except (OSError, ValueError):
            pass  # giữ bản tốt gần nhất
        return _state["flags"]


def is_enabled(key: str, default: bool = True, now: float | None = None) -> bool:
    d = (_load(time.time() if now is None else now) or {}).get(key)
    if not d or d.get("state") != "ENABLED":
        return default
    v = (d.get("variants") or {}).get(d.get("defaultVariant"))
    return v if isinstance(v, bool) else default
