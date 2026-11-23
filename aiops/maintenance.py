"""Bảo trì có kế hoạch (planned maintenance) — một thay đổi lớn được thông báo và trừ đúng chỗ, thay vì "lén" làm lúc khuya.

  lên lịch     tiêu đề + lời nhắn cho khách + service bị ảnh hưởng + [bắt đầu, kết thúc]; tối đa `max_hours`. Từ chối nếu chồng
               lên khung đóng băng (flash sale 8.34, khoá sổ 8.56) của chính các service đó — bảo trì cũng là thay đổi.
  silence      tạo NGAY silence Alertmanager (tương lai) cho đúng các service trong đúng khung → người trực không bị đánh thức
               bởi cảnh báo đã biết trước; huỷ/kết thúc sớm → gỡ silence.
  trang trạng  thông báo "bảo trì sắp tới" (≤ 7 ngày) và "đang bảo trì" (nhóm chức năng → under_maintenance).
  SLA          thời gian bảo trì được TRỪ khỏi uptime công khai và SLA người bán CHỈ khi báo trước ≥ `notice_hours` (mặc định
               48 giờ, như điều khoản SLA thường gặp); báo gấp thì vẫn tính là gián đoạn.
"""

from __future__ import annotations

DEFAULT = {"notice_hours": 48, "max_hours": 8, "upcoming_days": 7}


def cfg(raw: dict | None) -> dict:
    return {**DEFAULT, **(raw or {})}


def status_of(w: dict, now: float) -> str:
    if w.get("cancelled_at"):
        return "cancelled"
    end = w.get("completed_early_at") or w["ends"]
    if now < w["starts"]:
        return "scheduled"
    return "in_progress" if now < end else "completed"


def effective_end(w: dict) -> float:
    return float(w.get("completed_early_at") or w["ends"])


def eligible(w: dict, c: dict) -> bool:
    """Được trừ khỏi SLA: báo trước đủ hạn và không bị huỷ."""
    return not w.get("cancelled_at") and float(w["created_at"]) <= float(w["starts"]) - c["notice_hours"] * 3600


def exclusions(windows: list[dict], services: set[str], c: dict) -> list[tuple[float, float]]:
    """Các khoảng được trừ khỏi uptime của một nhóm chức năng (đã báo trước đủ hạn, chạm service của nhóm)."""
    return [(float(w["starts"]), effective_end(w)) for w in windows if eligible(w, c) and set(w.get("services") or []) & services]


def validate(body: dict, now: float, c: dict, known_services: set[str]) -> tuple[dict | None, str | None]:
    title = str(body.get("title") or "").strip()
    message = str(body.get("message") or "").strip()
    services = sorted({str(s) for s in body.get("services") or []})
    try:
        starts, ends = float(body["starts"]), float(body["ends"])
    except (KeyError, TypeError, ValueError):
        return None, "cần starts/ends (epoch giây)"
    if not title or len(message) < 10:
        return None, "cần tiêu đề và lời nhắn cho khách (≥ 10 ký tự)"
    if not services or not set(services) <= known_services:
        return None, f"service không hợp lệ: {', '.join(sorted(set(services) - known_services)) or 'trống'}"
    if starts < now - 300 or ends <= starts:
        return None, "khung thời gian không hợp lệ (bắt đầu trong quá khứ hoặc kết thúc trước bắt đầu)"
    if ends - starts > c["max_hours"] * 3600:
        return None, f"một khung bảo trì tối đa {c['max_hours']} giờ — chia nhỏ hoặc xin ngoại lệ"
    return {"title": title[:160], "message": message[:2000], "services": services, "starts": starts, "ends": ends}, None


def public(windows: list[dict], components: list[dict], now: float, c: dict) -> list[dict]:
    """Khung bảo trì công khai: đang diễn ra + sắp tới trong `upcoming_days` ngày. Chỉ tên nhóm chức năng, không lộ service."""
    from .statuspage import _iso

    name_of = {s: comp["name"] for comp in components for s in comp.get("services") or []}
    out = []
    for w in windows:
        st = status_of(w, now)
        if st not in ("scheduled", "in_progress") or float(w["starts"]) > now + c["upcoming_days"] * 86400:
            continue
        out.append({"id": w["id"], "title": w["title"], "message": w["message"], "status": st,
                    "components": sorted({name_of.get(s, "Hệ thống") for s in w.get("services") or []}),
                    "starts": _iso(float(w["starts"])), "ends": _iso(effective_end(w))})
    return out
