"""Ước lượng ảnh hưởng kinh doanh của sự cố (cost of downtime) — quy sự cố ra số đơn và tiền.

  thực tế      = đơn tạo trong [bắt đầu lỗi, khôi phục] (orders_created_total)
  kỳ vọng      = trung vị cùng khung giờ hôm qua và tuần trước (offset 1d, 1w) — tránh lệ thuộc một mốc bất thường
  hụt          = max(0, kỳ vọng − thực tế)
  mua bù       = phần đơn vượt kỳ vọng trong 1 giờ sau khôi phục (khách quay lại mua) → trừ ra, chỉ tính thiệt hại RÒNG
  GMV ước mất  = đơn mất ròng × giá trị đơn TB 7 ngày (order_gmv_vnd_total / orders_created_total)

Độ tin cậy thấp khi hai mốc so sánh lệch nhau > 50% (vd một mốc trùng flash sale) hoặc nền quá ít đơn. Đây là ước
lượng phục vụ ưu tiên đầu tư độ tin cậy, không phải số liệu kế toán (không ghi sổ).
"""

from __future__ import annotations

import logging
import statistics

log = logging.getLogger("aiops.impact")
OFFSETS = ("1d", "1w")


def _inc(prom, metric: str, window_s: float, at: float, offset: str | None = None) -> float | None:
    q = f"sum(increase({metric}[{max(60, int(window_s))}s]{f' offset {offset}' if offset else ''}))"
    try:
        r = prom.query(q, time=at)
    except Exception as e:  # noqa: BLE001 - thiếu dữ liệu thì bỏ mốc đó
        log.warning("impact query lỗi %s: %s", q, e)
        return None
    if not r:
        return None
    v = float(r[0]["value"][1])
    return None if v != v else v


def _expected(prom, window_s: float, at: float) -> tuple[float | None, list[float]]:
    base = [b for b in (_inc(prom, "orders_created_total", window_s, at, o) for o in OFFSETS) if b is not None]
    return (statistics.median(base) if base else None), base


def estimate(prom, start: float, end: float, now: float, default_aov: float = 0.0, rebound_s: int = 3600) -> dict:
    window = max(60.0, end - start)
    actual = _inc(prom, "orders_created_total", window, end)
    expected, base = _expected(prom, window, end)
    if actual is None or expected is None:
        return {"available": False, "reason": "thiếu dữ liệu orders_created_total (hiện tại hoặc mốc so sánh)"}
    deficit = max(0.0, expected - actual)
    rebound, rebound_done = 0.0, now >= end + rebound_s
    if rebound_done and deficit > 0:
        a2 = _inc(prom, "orders_created_total", rebound_s, end + rebound_s)
        e2, _ = _expected(prom, rebound_s, end + rebound_s)
        if a2 is not None and e2 is not None:
            rebound = min(deficit, max(0.0, a2 - e2))
    lost = max(0.0, deficit - rebound)
    gmv7 = _inc(prom, "order_gmv_vnd_total", 7 * 86400, end)
    n7 = _inc(prom, "orders_created_total", 7 * 86400, end)
    aov, aov_src = (gmv7 / n7, "7 ngày (order_gmv_vnd_total)") if gmv7 and n7 else (default_aov, "cấu hình mặc định")
    spread = (max(base) - min(base)) / max(1e-9, statistics.mean(base)) if len(base) == 2 else None
    low = expected < 5 or (spread is not None and spread > 0.5) or len(base) < 2
    return {
        "available": True, "window_s": round(window), "orders_actual": round(actual, 1), "orders_expected": round(expected, 1),
        "baselines": dict(zip(OFFSETS, [round(b, 1) for b in base])) if len(base) == 2 else [round(b, 1) for b in base],
        "orders_deficit": round(deficit, 1), "orders_rebound": round(rebound, 1), "rebound_measured": rebound_done,
        "orders_lost": round(lost, 1), "aov_vnd": round(aov), "aov_source": aov_src,
        "gmv_lost_vnd": round(lost * aov), "drop_ratio": round(deficit / expected, 3) if expected else None,
        "confidence": "low" if low else "medium",
        "note": ("mốc so sánh lệch nhau nhiều hoặc nền ít đơn — chỉ để tham khảo" if low else
                 "ước lượng từ so sánh cùng khung giờ; chưa đo mua bù" if not rebound_done else "đã trừ phần khách mua bù trong 1 giờ"),
    }


def vnd(x: float) -> str:
    return f"{x:,.0f} đ".replace(",", ".")
