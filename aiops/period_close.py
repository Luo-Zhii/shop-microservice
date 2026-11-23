"""Đóng sổ cuối kỳ (kế toán) × quản lý thay đổi (DevOps).

Ở doanh nghiệp, những ngày khoá sổ tháng (ngày cuối tháng → ngày làm việc thứ N tháng sau) là lúc kế toán đối chiếu công nợ,
tiền thu hộ, tồn kho và lập báo cáo. Một deploy chạm sổ cái hay luồng tiền đúng lúc đó có thể làm lệch số đã chốt, và
truy ra rất tốn công. Vì vậy hai việc:

  khung đóng sổ   [00:00 ngày cuối tháng M, 23:59:59 ngày `close_days` tháng M+1] giờ VN → deploy chạm `services`
                  (accounting, payment, order, warehouse) bị ép duyệt tay như đóng băng flash sale (8.34); khẩn cấp có audit.
                  Không cần mạng: lịch suy ra từ ngày tháng, nên không bao giờ fail-open.
  sẵn sàng khoá   BỔ SUNG checklist sổ sách của chính kế toán (/admin/periods/{p}/readiness: cân đối, hash chain, đối soát
                  cổng, tiền thu hộ treo, COD, GTGT) bằng phần kế toán KHÔNG nhìn thấy — đường ống dữ liệu vận hành: lệch tồn
                  warehouse ↔ inventory và lần đối soát gần nhất, outbox chưa phát (sự kiện chưa tới kế toán), tin nhắn vào DLQ
                  trong kỳ (bút toán có thể thiếu), sự cố còn mở trên service tài chính, hoàn phí SLA người bán đã ghi sổ chưa.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone

VN = timezone(timedelta(hours=7))
DEFAULT = {"enabled": True, "close_days": 3, "services": ["accounting", "payment", "order", "warehouse"]}


def _cfg(cfg: dict | None) -> dict:
    return {**DEFAULT, **(cfg or {})}


def window_of(year: int, month: int, cfg: dict | None = None) -> dict:
    """Khung đóng sổ của kỳ year-month."""
    c = _cfg(cfg)
    last = calendar.monthrange(year, month)[1]
    start = datetime(year, month, last, tzinfo=VN)
    ny, nm = (year + 1, 1) if month == 12 else (year, month + 1)
    end = datetime(ny, nm, int(c["close_days"]), 23, 59, 59, tzinfo=VN)
    return {"period": f"{year:04d}-{month:02d}", "starts": start.timestamp(), "ends": end.timestamp()}


def window_at(at: float, cfg: dict | None = None) -> dict | None:
    """Khung đóng sổ đang hiệu lực tại `at` (None nếu ngoài khung)."""
    d = datetime.fromtimestamp(at, VN)
    py, pm = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    for y, m in ((d.year, d.month), (py, pm)):
        w = window_of(y, m, cfg)
        if w["starts"] <= at <= w["ends"]:
            return w
    return None


def upcoming(now: float, cfg: dict | None = None) -> list[dict]:
    """Khung đang hiệu lực (nếu có) + khung kế tiếp."""
    d = datetime.fromtimestamp(now, VN)
    py, pm = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    out = [w for w in (window_of(py, pm, cfg), window_of(d.year, d.month, cfg)) if w["ends"] >= now]
    return [{**w, "active": w["starts"] <= now <= w["ends"]} for w in out]


def freeze(at: float, services: list[str], cfg: dict | None = None) -> dict | None:
    c = _cfg(cfg)
    if c.get("enabled") is False:
        return None
    hit = sorted(set(services) & set(c["services"]))
    w = window_at(at, c) if hit else None
    if not w:
        return None
    return {"active": True, "kind": "period_close", "services": hit, "period": w["period"], "window": [w["starts"], w["ends"]]}


def checks(q, store, period: str, now: float, scope: list[str], sla_due: list[str] | None = None,
           infra_required: bool = False) -> list[dict]:
    """`q(promql) → float | None` (None = không đọc được hoặc không có series). Mỗi mục: ok | warn | fail | unknown + giá trị + gợi ý xử lý."""
    y, m = map(int, period.split("-"))
    p_start = datetime(y, m, 1, tzinfo=VN).timestamp()
    rng = max(3600, int(now - p_start))
    out = []

    def add(key, title, status, value, hint):
        out.append({"key": key, "title": title, "status": status, "value": value, "hint": hint})

    v = q("max(warehouse_stock_drift_skus)")
    add("stock_drift", "Lệch tồn kho warehouse ↔ inventory (SKU)", "unknown" if v is None else "ok" if v == 0 else "fail", v,
        "kiểm kê lại các SKU lệch, điều chỉnh có chứng từ (giá vốn cuối kỳ phụ thuộc số tồn)")
    v = q("time() - max(warehouse_reconcile_last_success_timestamp_seconds)")
    add("reconcile_fresh", "Lần đối soát tồn gần nhất", "unknown" if v is None else "ok" if v <= 3 * 3600 else "warn",
        None if v is None else round(v / 3600, 1), "đối soát phải chạy trong 3 giờ gần nhất thì số lệch mới đáng tin")
    v = q("sum(outbox_pending)")
    add("outbox", "Sự kiện outbox chưa phát (chưa tới kế toán)", "unknown" if v is None else "ok" if v == 0 else "warn", v,
        "đợi relay phát hết, nếu kẹt thì xem log relay của order/payment")
    v = q(f'sum(increase(kafka_messages_consumed_total{{result="dlq",service=~"{"|".join(scope)}"}}[{rng}s])) or vector(0)')   # counter dlq chỉ sinh khi có lỗi
    add("dlq", "Tin nhắn vào DLQ trong kỳ (bút toán có thể thiếu)", "unknown" if v is None else "ok" if v < 0.5 else "fail",
        None if v is None else round(v), "xử lý lại DLQ (replay) hoặc ghi bút toán điều chỉnh có giải trình")
    open_inc = [i for i in store.list_incidents(limit=500, exclude_drills=True)
                if i["status"] in ("open", "acknowledged", "mitigated") and i["service"] in scope]
    add("incidents", "Sự cố còn mở trên service tài chính", "ok" if not open_inc else "warn", len(open_inc),
        "đóng sự cố hoặc ghi chú ảnh hưởng số liệu vào biên bản khoá sổ")
    if sla_due is not None:
        applied = any((a.get("details") or {}).get("period") == period for a in store.audit_events("sla_credits_applied"))
        add("sla_credits", "Hoàn phí SLA người bán đã ghi sổ", "ok" if not sla_due or applied else "fail",
            len(sla_due), "ghi hoàn phí ở tab Trang trạng thái → SLA (bút toán 5213/33311/331) trước khi khoá")
    if infra_required:
        posted = any((x.get("details") or {}).get("period") == period for x in store.audit_events("infra_cost_posted"))
        add("infra_cost", "Đã trích trước chi phí hạ tầng cloud (6417/6427 / 335)", "ok" if posted else "fail", None,
            "ghi ở AIOps → Dự báo dung lượng → Phân bổ chi phí hạ tầng; hoá đơn cloud về sau ngày khoá sổ nên phải trích trước")
    return out


def summary(items: list[dict]) -> dict:
    st = [i["status"] for i in items]
    return {"ready": "fail" not in st and "unknown" not in st, "fail": st.count("fail"), "warn": st.count("warn"),
            "unknown": st.count("unknown")}
