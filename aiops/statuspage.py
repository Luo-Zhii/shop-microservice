"""Trang trạng thái công khai (kiểu Statuspage) — giao tiếp sự cố với KHÁCH, tách khỏi dữ liệu vận hành nội bộ.

Nguyên tắc:
  • Chỉ công bố sự cố đã có ít nhất một CẬP NHẬT do người trực viết (status_updates). Alert thô, tên service nội bộ,
    giả thuyết RCA… không bao giờ lộ ra ngoài — khách chỉ thấy tên nhóm chức năng ("Thanh toán").
  • Trạng thái nhóm chức năng hiện tại: sự cố đang mở (critical → gián đoạn lớn, warning → suy giảm) + robot tổng hợp
    (bước hỏng → gián đoạn một phần). Lấy mức xấu nhất.
  • Uptime 90 ngày theo cách tính của Statuspage: phút gián đoạn lớn tính 100%, gián đoạn một phần 30%, suy giảm 0%.
  • Mức ảnh hưởng do NGƯỜI TRỰC khai khi đăng thông báo (impact) ghi đè suy luận từ severity của alert
    (critical → gián đoạn lớn, warning → suy giảm) — cho cả trạng thái hiện tại lẫn uptime.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

VN = timezone(timedelta(hours=7))
LEVELS = ("operational", "degraded_performance", "partial_outage", "major_outage")
WEIGHT = {"major_outage": 1.0, "partial_outage": 0.3, "degraded_performance": 0.0}
PHASES = ("investigating", "identified", "monitoring", "resolved")
SEV_LEVEL = {"critical": "major_outage", "warning": "degraded_performance"}


def _worst(a: str, b: str) -> str:
    return a if LEVELS.index(a) >= LEVELS.index(b) else b


def _day(ts: float):
    return datetime.fromtimestamp(ts, VN).date()


def _level(i: dict, impacts: dict[str, str] | None) -> str:
    return (impacts or {}).get(i["id"]) or SEV_LEVEL.get(i.get("severity") or "warning", "degraded_performance")


def uptime_days(incidents: list[dict], services: set[str], now: float, days: int = 90,
                impacts: dict[str, str] | None = None) -> list[dict]:
    """Mỗi ngày (giờ VN): % thời gian hoạt động có trọng số; sự cố chồng nhau tính theo mức nặng nhất tại từng phút."""
    end_day = _day(now)
    start_day = end_day - timedelta(days=days - 1)
    day_start = lambda d: datetime(d.year, d.month, d.day, tzinfo=VN).timestamp()  # noqa: E731
    lost = {start_day + timedelta(days=i): 0.0 for i in range(days)}
    # gom khoảng theo mức rồi quét theo phút để không cộng đôi phần chồng lấn
    spans = []
    for i in incidents:
        if i["service"] not in services:
            continue
        lvl = _level(i, impacts)
        if WEIGHT[lvl] == 0:
            continue
        a = float(i.get("fault_start") or i["detected_at"])
        b = float(i.get("resolved_at") or now)
        spans.append((max(a, day_start(start_day)), min(b, now), WEIGHT[lvl]))
    # sweep-line trên các mốc biên: giữa hai mốc liên tiếp, trọng số = mức nặng nhất đang diễn ra (không cộng đôi)
    marks = sorted({x for s0, e0, _ in spans for x in (s0, e0) if e0 > s0})
    for a, b in zip(marks, marks[1:]):
        w = max((wt for s0, e0, wt in spans if s0 <= a and e0 >= b), default=0.0)
        t = a
        while w and t < b:                                   # cắt đoạn [a, b) theo ranh giới ngày (giờ VN)
            d = _day(t)
            nxt = min(b, day_start(d + timedelta(days=1)))
            if d in lost:
                lost[d] += w * (nxt - t)
            t = nxt
    out = []
    for d, sec in lost.items():
        full = 86400.0 if d != end_day else max(60.0, now - day_start(d))
        up = max(0.0, 1 - sec / full)
        out.append({"date": d.isoformat(), "uptime": round(up, 5),
                    "status": "operational" if up >= 0.999 else "degraded" if up >= 0.98 else "outage"})
    return out


def build(store, now: float, components: list[dict], synthetic_failed_services: set[str] | None = None,
          history_days: int = 14, uptime_window: int = 90) -> dict:
    incidents = store.list_incidents(since=now - uptime_window * 86400, limit=5000)
    open_incs = [i for i in incidents if i["status"] in ("open", "acknowledged", "mitigated")]
    failed = synthetic_failed_services or set()
    updates = {i["id"]: store.status_updates(i["id"]) for i in incidents}
    impacts = {k: next((u["impact"] for u in reversed(v) if u.get("impact")), None) for k, v in updates.items()}
    impacts = {k: v for k, v in impacts.items() if v}
    comps = []
    for c in components:
        svcs = set(c.get("services") or [])
        status = "operational"
        for i in open_incs:
            if i["service"] in svcs:
                status = _worst(status, _level(i, impacts))
        if svcs & failed:
            status = _worst(status, "partial_outage")
        days = uptime_days(incidents, svcs, now, uptime_window, impacts)
        comps.append({"id": c["id"], "name": c["name"], "status": status, "days": days,
                      "uptime_90d": round(sum(d["uptime"] for d in days) / len(days), 5)})
    name_of = {s: c["name"] for c in components for s in c.get("services") or []}
    published = []
    for i in incidents:
        ups = updates[i["id"]]
        if not ups:
            continue                                  # chưa ai viết thông báo → không công bố
        last = ups[-1]
        if last["status"] == "resolved" and float(last["created_at"]) < now - history_days * 86400:
            continue
        published.append({"id": i["id"], "title": ups[0].get("title") or "Sự cố đang được xử lý",
                          "status": last["status"], "impact": _level(i, impacts),
                          "components": sorted({name_of.get(i["service"], "Hệ thống")}),
                          "started_at": _iso(float(i.get("fault_start") or i["detected_at"])),
                          "resolved_at": _iso(float(last["created_at"])) if last["status"] == "resolved" else None,
                          "updates": [{"status": u["status"], "message": u["message"], "at": _iso(float(u["created_at"]))}
                                      for u in reversed(ups)]})
    published.sort(key=lambda x: (x["status"] == "resolved", x["started_at"]), reverse=False)
    active = [p for p in published if p["status"] != "resolved"]
    overall = "operational"
    for c in comps:
        overall = _worst(overall, c["status"])
    return {"overall": overall, "updated_at": _iso(now), "components": comps, "active_incidents": active,
            "recent_incidents": [p for p in published if p["status"] == "resolved"][:10]}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")
