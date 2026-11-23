"""Diễn tập sự cố (game day) — chống "deskilling" khi tự động hoá nhiều (SRE 2026): kỹ năng xử lý sự cố hiếm mất dần nếu
không tập. Mỗi runbook (runbook-as-code) gắn một thí nghiệm chaos tái hiện tình huống (hoặc diễn tập trên bàn nếu không
có); kế hoạch ưu tiên runbook lâu chưa tập nhất; mỗi buổi đo TTD/TTM/TTR như sự cố thật và có theo đúng runbook không.
"""

from __future__ import annotations

import statistics

DAY = 86400.0


def plan(runbooks: list[dict], drills: list[dict], now: float, cadence_days: int = 90, k: int = 3) -> dict:
    done = [d for d in drills if d.get("status") == "completed"]
    rows = []
    for rb in runbooks:
        last = max((float(d["started_at"]) for d in done if d["runbook"] == rb["id"]), default=None)
        since = None if last is None else (now - last) / DAY
        overdue = since is None or since >= cadence_days
        # chưa từng tập > quá hạn lâu > sắp tới hạn; diễn tập có chaos được ưu tiên hơn diễn tập trên bàn khi ngang nhau
        priority = (10_000 if since is None else since) + (1 if rb.get("chaos") else 0)
        rows.append({**rb, "mode": "chaos" if rb.get("chaos") else "tabletop", "last_drill_at": last,
                     "days_since": None if since is None else round(since, 1), "overdue": overdue, "priority": round(priority, 1),
                     "command": (f"kubectl apply -f platform/chaos/experiments/{rb['chaos']}.yaml" if rb.get("chaos") else None)})
    rows.sort(key=lambda r: -r["priority"])
    return {"cadence_days": cadence_days, "overdue": sum(r["overdue"] for r in rows), "suggested": [r["id"] for r in rows[:k]],
            "items": rows}


def _dur(a, b):
    return None if a is None or b is None else round(float(b) - float(a), 1)


def summary(drills: list[dict], incidents: list[dict]) -> dict:
    done = [d for d in drills if d.get("status") == "completed"]
    ttr = [x for x in (_dur(d["started_at"], d.get("resolved_at")) for d in done) if x is not None]
    ttd = [x for x in (_dur(d["started_at"], d.get("detected_at")) for d in done) if x is not None]
    real = [float(i["resolved_at"]) - float(i["fault_start"] if i.get("fault_start") is not None else i["detected_at"])
            for i in incidents if i.get("resolved_at") is not None]
    followed = [int(d["followed_runbook"]) for d in done if d.get("followed_runbook") is not None]
    return {"drills": len(done), "ttd_median_s": statistics.median(ttd) if ttd else None,
            "ttr_median_s": statistics.median(ttr) if ttr else None,
            "real_mttr_median_s": round(statistics.median(real), 1) if real else None,
            "runbook_followed_ratio": round(sum(followed) / len(followed), 3) if followed else None}
