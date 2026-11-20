"""Phát hiện bất thường trên KPI có hướng (business / UX observability).

Bổ sung cho detector 6 đặc trưng hạ tầng: có những sự cố HTTP vẫn 200 nhưng người dùng không đặt được đơn (lỗi logic
checkout, khuyến mãi sai, cổng thanh toán từ chối) hoặc trang chậm phía trình duyệt. KPI khai báo trong config
`kpis: {service: {tên_đặc_trưng: {direction: up|down, min_level?}}}` — `up` = tăng là xấu (LCP, lỗi JS, tỉ lệ thanh toán
lỗi), `down` = giảm là xấu (số đơn/giây). Điểm = robust z (median/MAD) của trung bình 3 điểm gần nhất so với cửa sổ học,
chỉ tính theo chiều xấu, ánh xạ về [0, 1].
"""

from __future__ import annotations

import numpy as np


def robust_z(series: np.ndarray, train: slice, recent: int = 3) -> float:
    x = np.asarray(series, dtype=float)
    x = x[~np.isnan(x)]
    base = x[train] if len(x) > (train.stop or 0) else x[: max(1, len(x) - recent)]
    base = base[~np.isnan(base)]
    if len(base) < 10 or len(x) < recent:
        return 0.0
    med = float(np.median(base))
    mad = float(np.median(np.abs(base - med))) * 1.4826
    scale = max(mad, abs(med) * 0.05, 1e-9)  # sàn 5% mức nền: tránh z vô hạn khi chuỗi phẳng
    return (float(np.mean(x[-recent:])) - med) / scale


def kpi_scores(raw: dict[str, np.ndarray], spec: dict[str, dict], train: slice) -> tuple[float, list[tuple[str, float]]]:
    """→ (điểm KPI tổng của service [0..1], danh sách (kpi, z theo chiều xấu) giảm dần)."""
    out: list[tuple[str, float]] = []
    for name, cfg in (spec or {}).items():
        series = raw.get(name)
        if series is None or np.count_nonzero(~np.isnan(np.asarray(series, dtype=float))) < 20:
            continue
        z = robust_z(series, train)
        bad = z if cfg.get("direction", "up") == "up" else -z
        level = float(np.nanmean(np.asarray(series, dtype=float)[-3:]))
        if cfg.get("min_level") is not None and cfg.get("direction", "up") == "up" and level < float(cfg["min_level"]):
            bad = min(bad, 0.0)  # tăng nhưng vẫn dưới ngưỡng tuyệt đối có ý nghĩa (vd LCP < 2.5s) → bỏ qua
        if bad > 0:
            out.append((name, round(bad, 2)))
    out.sort(key=lambda kv: -kv[1])
    top = out[0][1] if out else 0.0
    return float(np.clip((top - 3.0) / 4.0, 0.0, 1.0)), out
