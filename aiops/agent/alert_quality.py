"""Chất lượng cảnh báo (alert hygiene) — chống "mệt mỏi vì cảnh báo" theo thực hành SRE.

Với mỗi alertname (alert đầu tiên tạo sự cố) trong N ngày: số sự cố, tỉ lệ tự hết rất nhanh (< flap_s, flapping),
tỉ lệ được người nhận (acknowledged), tỉ lệ dẫn tới hành động khắc phục, thời gian tồn tại trung vị.
Khuyến nghị theo luật:
  noisy      nhiều sự cố, đa số tự hết nhanh, ít ai nhận → tăng `for:`/ngưỡng hoặc gộp
  ticket     ít khi cần hành động khắc phục, không ai nhận gấp → hạ từ page xuống ticket
  actionable phần lớn dẫn tới hành động → giữ nguyên
"""

from __future__ import annotations

import statistics
from collections import defaultdict


def analyze(store, now: float, days: int = 30, flap_s: int = 300, min_count: int = 3) -> dict:
    incs = store.list_incidents(since=now - days * 86400, limit=5000, exclude_drills=True)
    by: dict[str, list[dict]] = defaultdict(list)
    for i in incs:
        name = next((a.get("alertname") for a in (i.get("alerts") or []) if a.get("alertname")), None) or "unknown"
        by[name].append(i)
    rows = []
    for name, items in by.items():
        n = len(items)
        resolved = [i for i in items if i.get("resolved_at")]
        durs = [i["resolved_at"] - i["detected_at"] for i in resolved]
        flappy = sum(1 for d in durs if d < flap_s)
        acked = sum(1 for i in items if i.get("acknowledged_at"))
        acted = sum(1 for i in items if any(a["status"] in ("executed", "dry_run", "approved")
                                            for a in store.actions_for(i["id"])))
        r = {"alertname": name, "incidents": n, "flapping_ratio": round(flappy / n, 3), "ack_ratio": round(acked / n, 3),
             "action_ratio": round(acted / n, 3), "median_duration_s": round(statistics.median(durs), 1) if durs else None,
             "services": sorted({i["service"] for i in items})}
        if n < min_count:
            r["recommendation"], r["reason"] = "insufficient", f"mới {n} sự cố — chưa đủ để kết luận"
        elif r["flapping_ratio"] >= 0.5 and r["ack_ratio"] < 0.3:
            r["recommendation"], r["reason"] = "noisy", "đa số tự hết < 5 phút và ít ai nhận — tăng `for:`/ngưỡng hoặc gộp"
        elif r["action_ratio"] < 0.2 and r["ack_ratio"] < 0.5:
            r["recommendation"], r["reason"] = "ticket", "hiếm khi cần khắc phục — hạ từ page xuống ticket"
        else:
            r["recommendation"], r["reason"] = "actionable", "phần lớn dẫn tới xử lý — giữ nguyên"
        rows.append(r)
    rows.sort(key=lambda r: ({"noisy": 0, "ticket": 1, "actionable": 2, "insufficient": 3}[r["recommendation"]], -r["incidents"]))
    total = len(incs)
    noisy = sum(r["incidents"] for r in rows if r["recommendation"] == "noisy")
    return {"days": days, "incidents": total, "noise_ratio": round(noisy / total, 3) if total else 0.0, "items": rows}
