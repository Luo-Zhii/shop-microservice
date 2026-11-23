"""Lịch trực luân phiên + leo thang (kiểu PagerDuty/Opsgenie) — mỗi sự cố có người chịu trách nhiệm.

  rotation      danh sách người trực; tuần i: người i trực CHÍNH, người i+1 trực PHỤ (xoay vòng), đổi ca tại `start`
  overrides     đổi ca đột xuất [{from, to, primary}] (ốm, nghỉ phép) — ưu tiên hơn lịch xoay
  leo thang     sự cố đang mở chưa ai nhận quá `escalate_after_minutes` → báo người trực phụ, MỖI sự cố một lần, có audit
"""

from __future__ import annotations

from datetime import datetime

WEEK = 7 * 86400


def _ts(s) -> float:
    return s if isinstance(s, (int, float)) else datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()


def shift(cfg: dict, at: float) -> dict | None:
    people = cfg.get("rotation") or []
    if not people:
        return None
    start = _ts(cfg.get("start", "2026-11-02T09:00:00+07:00"))
    i = int((at - start) // WEEK)
    s0 = start + i * WEEK
    primary, secondary = people[i % len(people)], people[(i + 1) % len(people)]
    over = next((o for o in cfg.get("overrides") or [] if _ts(o["from"]) <= at < _ts(o["to"])), None)
    if over:
        primary = next((p for p in people if p["name"] == over["primary"]), {"name": over["primary"]})
    return {"start": s0, "end": s0 + WEEK, "primary": primary, "secondary": secondary, "override": bool(over)}


def schedule(cfg: dict, now: float, weeks: int = 4) -> list[dict]:
    first = shift(cfg, now)
    if not first:
        return []
    return [shift(cfg, first["start"] + k * WEEK + 1) for k in range(weeks)]


def escalate(store, notifier, cfg: dict, now: float) -> list[dict]:
    """Sự cố đang mở (chưa ai nhận) quá ngưỡng → báo người trực phụ một lần."""
    after = float(cfg.get("escalate_after_minutes", 15)) * 60
    sh = shift(cfg, now)
    if not sh:
        return []
    out = []
    for inc in store.list_incidents(status="open", limit=500):
        if inc.get("acknowledged_at") or now - float(inc["detected_at"]) < after:
            continue
        if any(a["event"] == "escalated" for a in store.audit_for(inc["id"])):
            continue
        sec = sh["secondary"]
        mins = int((now - float(inc["detected_at"])) // 60)
        notifier.notify(f"[LEO THANG] {inc['service']} — {inc['id'][:8]}",
                        f"Sự cố mở {mins} phút chưa ai nhận (trực chính: {sh['primary']['name']}). "
                        f"Chuyển trực phụ {sec['name']} {sec.get('handle', '')}".strip() + f"\n{inc.get('title') or ''}")
        store.audit("oncall", "escalated", inc["id"], details={"to": sec["name"], "after_minutes": mins})
        out.append({"incident": inc["id"], "to": sec["name"], "minutes_open": mins})
    return out
