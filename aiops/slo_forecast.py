"""Dự báo ngày CẠN error budget (predictive error-budget management — SRE 2026).

Trạng thái SLO hiện tại (burn rate) nói "đang đốt nhanh"; đội vận hành cần biết "còn bao lâu thì hết" để quyết đóng băng
thay đổi hay dồn người sửa lỗi TRƯỚC khi hết. Cách làm giải thích được:
  • chuỗi budget còn lại (Sloth `slo:period_error_budget_remaining:ratio`) 24 giờ, mỗi giờ một điểm;
  • độ dốc Theil–Sen = trung vị độ dốc mọi cặp điểm — bền với nhiễu và bước nhảy (một sự cố ngắn không bẻ cong xu hướng);
  • ETA = budget còn lại / tốc độ giảm (chỉ khi đang giảm và còn > 0); budget không giảm → không có ETA.
"""

from __future__ import annotations

import math

import numpy as np


def theil_sen(xs: np.ndarray, ys: np.ndarray) -> float | None:
    m = ~(np.isnan(xs) | np.isnan(ys))
    x, y = xs[m], ys[m]
    if len(x) < 3:
        return None
    i, j = np.triu_indices(len(x), k=1)
    dx = x[j] - x[i]
    ok = dx != 0
    return float(np.median((y[j] - y[i])[ok] / dx[ok])) if ok.any() else None


def eta_hours(grid_s: np.ndarray, remaining: np.ndarray) -> dict:
    """→ {slope_per_day, eta_hours|None, points}; thời gian tính bằng giây trên lưới Prometheus."""
    slope = theil_sen(grid_s / 3600.0, remaining)                # đơn vị: phần budget / giờ
    pts = int(np.count_nonzero(~np.isnan(remaining)))
    last = next((float(v) for v in remaining[::-1] if not math.isnan(v)), None)
    out = {"slope_per_day": None if slope is None else round(slope * 24, 5), "eta_hours": None, "points": pts}
    if slope is not None and slope < 0 and last is not None and last > 0:
        out["eta_hours"] = round(last / -slope, 1)
    return out


def forecast(prom, now: float, lookback_h: int = 24, step_s: int = 3600) -> dict[str, dict]:
    grid, series = prom.range_by_label("slo:period_error_budget_remaining:ratio", now - lookback_h * 3600, now, step_s,
                                       label="sloth_slo")
    return {slo: eta_hours(grid, arr) for slo, arr in series.items()}
