from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone


def uuid7() -> str:
    """UUID v7 (48 bit mili-giây + ngẫu nhiên) — sắp theo thời gian như quy ước ShopNow."""
    ms = int(time.time() * 1000)
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms & ((1 << 48) - 1)) << 80 | (0x7 << 76) | ((rand >> 62) & 0xFFF) << 64 | (0b10 << 62) | (rand & ((1 << 62) - 1))
    return str(uuid.UUID(int=value))


def parse_ts(v) -> float | None:
    """ISO-8601 / epoch giây → epoch giây. Bỏ qua mốc 0001-01-01 của Alertmanager."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    try:
        return float(s)
    except ValueError:
        pass
    if s.startswith("0001-01-01"):
        return None
    s = s.replace("Z", "+00:00")
    if "." in s:  # Go gửi nano giây — Python chỉ nhận micro giây
        head, _, tail = s.partition(".")
        frac = "".join(ch for ch in tail if ch.isdigit())
        rest = tail[len(frac):]
        s = f"{head}.{frac[:6]}{rest}"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
