"""Dự báo dung lượng (capacity forecasting) → scale TRƯỚC khi tải lên (predictive autoscaling).

HPA/KEDA chỉ phản ứng khi tải đã tới (trễ 1–3 phút + thời gian khởi động pod). Với lưu lượng có mùa vụ theo ngày
(giờ cao điểm trưa/tối, flash sale 20h), dự báo 1 giờ tới cho phép nâng số replica tối thiểu trước.

- Holt-Winters cộng tính (mức + xu hướng + mùa vụ 1 ngày) khi có ≥ 2 chu kỳ dữ liệu; ít hơn → Holt (mức + xu hướng).
- Tham số α, β, γ chọn bằng lưới nhỏ theo sai số dự báo 1 bước (in-sample) — không cần thư viện ngoài.
- Đề xuất replica = ⌈đỉnh dự báo × (1 + headroom) / rps mỗi pod⌉, kẹp trong [min, max].
"""

from __future__ import annotations

import itertools
import math

import numpy as np

GRID = (0.1, 0.3, 0.6)


def _ffill(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float).copy()
    ok = ~np.isnan(x)
    if not ok.any():
        return np.zeros_like(x)
    idx = np.where(ok, np.arange(len(x)), 0)
    np.maximum.accumulate(idx, out=idx)
    x = x[idx]
    x[: np.argmax(ok)] = x[np.argmax(ok)]
    return x


def holt_winters(x: np.ndarray, season: int | None, alpha: float, beta: float, gamma: float, horizon: int) -> tuple[np.ndarray, float]:
    """→ (dự báo `horizon` bước, SSE dự báo 1 bước trong mẫu)."""
    n = len(x)
    if season and n >= 2 * season:
        level = float(np.mean(x[:season]))
        trend = float((np.mean(x[season:2 * season]) - np.mean(x[:season])) / season)
        seas = list(x[:season] - level)
    else:
        season, level, trend, seas = None, float(x[0]), float(x[1] - x[0]) if n > 1 else 0.0, []
    sse = 0.0
    for t in range(n):
        s = seas[t % season] if season else 0.0
        pred = level + trend + s
        if t > 0:
            sse += (x[t] - pred) ** 2
        prev = level
        level = alpha * (x[t] - s) + (1 - alpha) * (level + trend)
        trend = beta * (level - prev) + (1 - beta) * trend
        if season:
            seas[t % season] = gamma * (x[t] - level) + (1 - gamma) * s
    fc = np.array([level + (h + 1) * trend + (seas[(n + h) % season] if season else 0.0) for h in range(horizon)])
    return np.maximum(fc, 0.0), sse


VN_OFFSET = 7 * 3600


def _dow(start_ts: float, n: int, step_s: int) -> np.ndarray:
    """Thứ trong tuần theo giờ VN cho n điểm từ start_ts: 0 = thứ Hai (1/1/1970 là thứ Năm → +3)."""
    return ((int(start_ts) + VN_OFFSET + np.arange(n, dtype=np.int64) * step_s) // 86400 + 3) % 7


def weekday_factors(x: np.ndarray, start_ts: float, step_s: int) -> np.ndarray | None:
    """Hệ số theo thứ trong tuần (giờ VN) = trung bình thứ đó / trung bình chung; cần ≥ 14 ngày (2 lần mỗi thứ)."""
    x = np.asarray(x, dtype=float)
    real = ~np.isnan(x)                      # chỉ điểm THẬT — phần lấp (ffill) của lưới truy vấn sẽ làm lệch hệ số
    if np.count_nonzero(real) * step_s < 14 * 86400:
        return None
    dow = _dow(start_ts, len(x), step_s)
    overall = float(np.mean(x[real]))
    if overall <= 0:
        return None
    f = np.array([float(np.mean(x[real & (dow == d)])) / overall if np.any(real & (dow == d)) else 1.0 for d in range(7)])
    return np.clip(f, 0.2, 5.0)


def forecast(series: np.ndarray, step_s: int, horizon_s: int = 3600, season_s: int = 86400,
             start_ts: float | None = None) -> dict:
    """`start_ts` = thời điểm của điểm đầu chuỗi; có ≥ 14 ngày thì khử mùa vụ tuần trước khi chạy Holt-Winters ngày."""
    wf = weekday_factors(series, start_ts, step_s) if start_ts is not None else None
    x = _ffill(series)
    season = season_s // step_s
    horizon = max(1, horizon_s // step_s)
    if wf is not None:
        dow = _dow(start_ts, len(x) + horizon, step_s)
        x = x / wf[dow[: len(x)]]
    use_season = len(x) >= 2 * season
    best = None
    for a, b, g in itertools.product(GRID, GRID, GRID if use_season else (0.0,)):
        fc, sse = holt_winters(x, season if use_season else None, a, b, g, horizon)
        if best is None or sse < best[1]:
            best = (fc, sse, (a, b, g))
    fc, sse, params = best
    rmse = math.sqrt(sse / max(1, len(x) - 1))
    current = float(x[-1])
    if wf is not None:
        fut = wf[dow[len(x):]]
        fc = fc * fut
        current = current * wf[dow[len(x) - 1]]
        rmse = rmse * float(np.max(fut))
    return {"model": ("holt-winters" if use_season else "holt") + ("+weekly" if wf is not None else ""),
            "params": dict(zip(("alpha", "beta", "gamma"), params)),
            "current": round(current, 3), "peak": round(float(fc.max()), 3), "forecast": [round(float(v), 3) for v in fc],
            "rmse": round(rmse, 3), "weekday_factors": None if wf is None else [round(float(v), 3) for v in wf]}


def recommend(peak: float, rmse: float, rps_per_pod: float, min_r: int, max_r: int, headroom: float = 0.3) -> int:
    """Đỉnh dự báo + 1 RMSE (đề phòng dự báo thấp) + headroom, chia công suất mỗi pod."""
    need = (peak + rmse) * (1 + headroom) / max(rps_per_pod, 1e-9)
    return int(min(max_r, max(min_r, math.ceil(need))))


# ---------------------------------------------------------------- sự kiện ngoại sinh (flash sale đã lên lịch)
def event_uplift(series: np.ndarray, start: float, step: int, past: list[tuple[float, float]], season_s: int = 86400) -> float | None:
    """Hệ số tăng tải học từ các flash sale đã qua: trung vị (rps trong sale / rps cùng khung giờ hôm trước)."""
    x = np.asarray(series, dtype=float)
    ratios = []
    for s, e in past:
        i0, i1 = int((s - start) // step), int(math.ceil((e - start) / step))
        j0, j1 = i0 - season_s // step, i1 - season_s // step
        if j0 < 0 or i1 > len(x) or i1 <= i0:
            continue
        a, b = np.nanmean(x[i0:i1]), np.nanmean(x[j0:j1])
        if np.isfinite(a) and np.isfinite(b) and b > 0:
            ratios.append(a / b)
    return round(float(np.median(ratios)), 3) if ratios else None


def apply_events(fc: list[float], fc_start: float, step: int, upcoming: list[tuple[float, float]], uplift: float) -> list[float]:
    """Nhân hệ số tăng tải vào các bước dự báo rơi trong khung flash sale sắp tới."""
    return [round(v * uplift, 3) if any(s <= fc_start + h * step < e for s, e in upcoming) else v for h, v in enumerate(fc)]
