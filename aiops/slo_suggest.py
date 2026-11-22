"""Gợi ý mục tiêu SLO từ dữ liệu quan sát (SRE 2026: "AI đề xuất SLO từ observability có sẵn") — giải thích được.

Với mỗi service: availability từng ngày 28 ngày (1 − 5xx/tổng). Đề xuất = bậc "số 9" cao nhất mà ≥ 90% số ngày đã đạt
(phân vị 10% của availability ngày) — mục tiêu phản ánh mức hệ thống ĐANG làm được, không phải mong muốn.
So với SLO availability hiện có (Sloth `slo:objective:ratio`):
  too_strict  thực tế 28 ngày < mục tiêu  → budget đốt liên tục, cảnh báo thành tiếng ồn (hạ mục tiêu hoặc sửa độ tin cậy)
  too_loose   đề xuất cao hơn mục tiêu ≥ 1 bậc → budget không bao giờ dùng tới (nâng để cam kết có ý nghĩa)
  no_slo      chưa có SLO → kèm đoạn YAML Sloth soạn sẵn để mở PR
"""

from __future__ import annotations

import numpy as np

LADDER = [0.99, 0.995, 0.999, 0.9995, 0.9999]
DAY = 86400


def suggest_objective(daily: np.ndarray) -> float | None:
    d = daily[~np.isnan(daily)]
    if len(d) < 7:
        return None
    p10 = float(np.percentile(d, 10))
    ok = [x for x in LADDER if x <= p10 + 1e-12]
    return ok[-1] if ok else LADDER[0]


def verdict(achieved: float | None, suggested: float | None, current: float | None) -> str:
    if suggested is None or achieved is None:
        return "insufficient"
    if current is None:
        return "no_slo"
    if achieved < current:
        return "too_strict"
    if LADDER.index(suggested) > (LADDER.index(current) if current in LADDER else -1) and suggested > current:
        return "too_loose"
    return "ok"


def sloth_snippet(service: str, objective: float) -> str:
    return (f"    - name: {service}-availability\n      objective: {objective * 100:g}\n"
            f"      description: Tỉ lệ request không lỗi 5xx của {service} (đề xuất từ 28 ngày dữ liệu)\n"
            "      sli:\n        events:\n"
            f'          errorQuery: sum(rate(http_server_requests_seconds_count{{service="{service}",status=~"5.."}}[{{{{.window}}}}]))\n'
            f'          totalQuery: sum(rate(http_server_requests_seconds_count{{service="{service}"}}[{{{{.window}}}}]))\n')


def analyze(prom, now: float, slo_services: dict[str, list[str]], days: int = 28) -> dict:
    q = ('1 - sum by (service) (increase(http_server_requests_seconds_count{status=~"5.."}[1d]))'
         ' / clamp_min(sum by (service) (increase(http_server_requests_seconds_count[1d])), 1)')
    _, daily = prom.range_by_label(q, now - days * DAY, now, DAY)
    current: dict[str, float] = {}
    try:
        obj = {r["metric"].get("sloth_slo"): float(r["value"][1]) for r in prom.query("slo:objective:ratio")}
    except Exception:  # noqa: BLE001 - không có Sloth → coi như chưa có SLO nào
        obj = {}
    for slo, svcs in slo_services.items():   # chỉ SLO availability một-service mới so trực tiếp được
        if slo.endswith("-availability") and len(svcs) == 1 and slo in obj:
            current[svcs[0]] = obj[slo]
    items = []
    for svc, arr in sorted(daily.items()):
        vals = arr[~np.isnan(arr)]
        achieved = float(np.mean(vals)) if len(vals) else None
        sug = suggest_objective(arr)
        cur = current.get(svc)
        v = verdict(achieved, sug, cur)
        items.append({"service": svc, "days": int(len(vals)), "achieved": None if achieved is None else round(achieved, 6),
                      "daily_p10": None if not len(vals) else round(float(np.percentile(vals, 10)), 6),
                      "current": cur, "suggested": sug, "verdict": v,
                      "snippet": sloth_snippet(svc, sug) if v == "no_slo" and sug else None})
    order = {"too_strict": 0, "no_slo": 1, "too_loose": 2, "ok": 3, "insufficient": 4}
    items.sort(key=lambda x: (order[x["verdict"]], x["service"]))
    return {"days": days, "ladder": LADDER, "items": items}
