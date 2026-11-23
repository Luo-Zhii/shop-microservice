"""Bốn chỉ số DORA (Accelerate / State of DevOps) tính từ chính dữ liệu của nền tảng, không khai báo tay.

  deployment_frequency   số deploy/ngày (deploy_records — promote.yml ghi mỗi lần đẩy môi trường)
  lead_time              trung vị thời gian từ commit tới khi deploy (record_deploy.py gửi lead_time_s)
  change_failure_rate    tỉ lệ deploy gây sự cố — nhãn đã làm sạch bằng RCA (mục 8.32b)
  time_to_restore        trung vị thời gian từ lúc lỗi bắt đầu (fault_start, không có thì detected_at) tới khi đóng sự cố

Mỗi chỉ số được xếp elite/high/medium/low theo ngưỡng của báo cáo State of DevOps; so với cửa sổ liền trước để thấy xu hướng.
"""

from __future__ import annotations

import statistics

DAY = 86400.0
BANDS = ("elite", "high", "medium", "low")


def band(metric: str, v: float | None) -> str | None:
    if v is None:
        return None
    if metric == "deployment_frequency":  # deploy/ngày: theo yêu cầu (≥1/ngày) · ≥1/tuần · ≥1/tháng · ít hơn
        return "elite" if v >= 1 else "high" if v >= 1 / 7 else "medium" if v >= 1 / 30 else "low"
    if metric == "lead_time":  # giây: < 1 ngày · < 1 tuần · < 1 tháng · lâu hơn
        return "elite" if v < DAY else "high" if v < 7 * DAY else "medium" if v < 30 * DAY else "low"
    if metric == "change_failure_rate":  # tỉ lệ
        return "elite" if v <= 0.05 else "high" if v <= 0.10 else "medium" if v <= 0.15 else "low"
    if metric == "time_to_restore":  # giây: < 1 giờ · < 1 ngày · < 1 tuần · lâu hơn
        return "elite" if v < 3600 else "high" if v < DAY else "medium" if v < 7 * DAY else "low"
    raise ValueError(metric)


def _window(deploys: list[dict], incidents: list[dict], start: float, end: float, environment: str | None) -> dict:
    ds = [d for d in deploys if start <= d["deployed_at"] < end and (not environment or d.get("environment") == environment)]
    lab = [d for d in ds if d.get("label") is not None]
    leads = [d["lead_time_s"] for d in ds if d.get("lead_time_s") is not None]
    restores = [i["resolved_at"] - (i.get("fault_start") or i["detected_at"])
                for i in incidents if i.get("resolved_at") and start <= i["resolved_at"] < end]
    days = (end - start) / DAY
    m = {
        "deployment_frequency": round(len(ds) / days, 3) if days else None,
        "lead_time": round(statistics.median(leads), 1) if leads else None,
        "change_failure_rate": round(sum(d["label"] for d in lab) / len(lab), 3) if lab else None,
        "time_to_restore": round(statistics.median(restores), 1) if restores else None,
    }
    return {"metrics": m, "counts": {"deploys": len(ds), "labeled": len(lab), "with_lead_time": len(leads), "restored": len(restores)}}


def report(store, now: float, days: int = 30, environment: str | None = None) -> dict:
    start, prev = now - days * DAY, now - 2 * days * DAY
    deploys = store.deploys()
    incidents = store.list_incidents(since=prev - 30 * DAY, limit=10000, exclude_drills=True)
    cur, before = _window(deploys, incidents, start, now, environment), _window(deploys, incidents, prev, start, environment)
    out = {}
    for k, v in cur["metrics"].items():
        out[k] = {"value": v, "band": band(k, v), "previous": before["metrics"][k], "previous_band": band(k, before["metrics"][k])}
    rated = [BANDS.index(x["band"]) for x in out.values() if x["band"]]
    # mức tổng = mức của chỉ số yếu nhất (một chuỗi giao hàng chỉ nhanh bằng khâu chậm nhất)
    overall = BANDS[max(rated)] if len(rated) == 4 else None
    return {"days": days, "environment": environment, "overall": overall, "metrics": out, "counts": cur["counts"]}
