"""Lịch thay đổi (ITIL Forward Schedule of Change) — MỘT nơi xem mọi mốc ảnh hưởng tới việc deploy/vận hành, và feed iCalendar
để đội thêm vào Google Calendar/Outlook thay vì nhớ từng trang.

Nguồn (đều đã có ở các mục trước, ở đây chỉ hợp nhất):
  freeze        khung đóng băng quanh flash sale (8.34)            → không deploy đường mua hàng
  period_close  khung khoá sổ cuối kỳ (8.56)                       → không deploy service tài chính
  maintenance   bảo trì có kế hoạch (8.59)                         → đã báo khách, có silence
  oncall        ca trực tuần (8.52)                                → ai chịu trách nhiệm
  vuln_due      hạn vá lỗ hổng P1/P2 (8.53, 8.54)                  → việc bảo mật có hạn chót
  action_due    hạn việc cần làm sau sự cố (8.62)                 → bài học phải thành việc làm

Feed .ics ký HMAC có hạn (như link duyệt hành động) — ứng dụng lịch không gửi được token đăng nhập, nên gateway mở ĐÚNG một
đường GET /api/aiops/calendar/feed.ics và AIOps tự kiểm chữ ký.
"""

from __future__ import annotations

from datetime import datetime, timezone

KINDS = ("freeze", "period_close", "maintenance", "oncall", "vuln_due", "action_due")


def event(kind: str, uid: str, title: str, starts: float, ends: float, detail: str = "", severity: str = "info") -> dict:
    return {"id": f"{kind}:{uid}", "kind": kind, "title": title, "starts": float(starts), "ends": float(max(ends, starts + 60)),
            "detail": detail, "severity": severity}


def window(events: list[dict], start: float, end: float) -> list[dict]:
    """Sự kiện giao với [start, end), sắp theo thời điểm bắt đầu; ca trực xếp sau cùng trong cùng thời điểm."""
    out = [e for e in events if e["starts"] < end and e["ends"] > start]
    out.sort(key=lambda e: (e["starts"], e["kind"] == "oncall", e["title"]))
    return out


# ---------------------------------------------------------------- iCalendar (RFC 5545)
def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\\n").replace("\n", "\\n")


def _fold(line: str) -> list[str]:
    """Gập dòng ở 75 octet (UTF-8), dòng tiếp bắt đầu bằng một khoảng trắng — không cắt giữa ký tự nhiều byte."""
    out, cur = [], ""
    for ch in line:
        limit = 75 if not out else 74
        if len((cur + ch).encode()) > limit:
            out.append(cur)
            cur = ch
        else:
            cur += ch
    out.append(cur)
    return [out[0]] + [" " + x for x in out[1:]]


def _dt(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def to_ics(events: list[dict], now: float, name: str = "ShopNow — lịch thay đổi") -> str:
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ShopNow//AIOps change calendar//VI", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", f"X-WR-CALNAME:{_esc(name)}", "X-WR-TIMEZONE:Asia/Ho_Chi_Minh",
             "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"]
    for e in events:
        lines += ["BEGIN:VEVENT", f"UID:{e['id']}@shopnow-aiops", f"DTSTAMP:{_dt(now)}", f"DTSTART:{_dt(e['starts'])}",
                  f"DTEND:{_dt(e['ends'])}", f"SUMMARY:{_esc(e['title'])}", f"CATEGORIES:{e['kind'].upper()}",
                  "TRANSP:TRANSPARENT" if e["kind"] == "oncall" else "TRANSP:OPAQUE"]
        if e.get("detail"):
            lines.append(f"DESCRIPTION:{_esc(e['detail'])}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(x for ln in lines for x in _fold(ln)) + "\r\n"
