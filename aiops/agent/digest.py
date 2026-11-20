"""Bản tin bàn giao ca trực (on-call handoff digest) — tổng hợp N giờ qua từ store, không dùng LLM.

Nội dung: sự cố mới / đang mở / đã đóng, MTTR trung vị, service ồn nhất, số alert đã gộp theo topology, hành động
khắc phục theo kết quả, bản điều tra của tác tử (grounding, chi phí), PR GitOps bị cổng xác minh chặn, việc cần chú ý.
"""

from __future__ import annotations

import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone

VN = timezone(timedelta(hours=7))


def _fmt_dur(s: float | None) -> str:
    if s is None:
        return "—"
    s = int(s)
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def build(store, now: float, hours: int = 24) -> dict:
    since = now - hours * 3600
    new = store.list_incidents(since=since, limit=500)
    still_open = [i for i in store.list_incidents(limit=500) if i["status"] in ("open", "acknowledged", "mitigated")]
    resolved = [i for i in new if i.get("resolved_at")]
    mttr = [i["resolved_at"] - (i.get("fault_start") or i["detected_at"]) for i in resolved]
    audit = store._exec("SELECT event, COUNT(*) AS n FROM audit WHERE ts >= ? GROUP BY event", (since,))
    ev = {r["event"]: int(r["n"]) for r in audit}
    actions = store._exec("SELECT type, status, COUNT(*) AS n FROM actions WHERE created_at >= ? GROUP BY type, status", (since,))
    invs = store._exec("SELECT mode, grounding, cost FROM investigations WHERE created_at >= ?", (since,))
    costs = [store._dec(r)["cost"] for r in invs]
    noisy = Counter(i["service"] for i in new).most_common(3)
    attention = []
    stale = [i for i in still_open if now - i["detected_at"] > 4 * 3600 and not i.get("acknowledged_at")]
    if stale:
        attention.append(f"{len(stale)} sự cố mở > 4h chưa ai nhận: {', '.join(i['service'] for i in stale[:5])}")
    pending = [a for a in actions if a["status"] == "pending_approval"]
    if pending:
        attention.append(f"{sum(int(a['n']) for a in pending)} hành động khắc phục đang chờ duyệt")
    if ev.get("gitops_pr_rejected"):
        attention.append(f"cổng xác minh chặn {ev['gitops_pr_rejected']} PR của tác tử — rà công cụ/runbook")
    if noisy and noisy[0][1] >= 3:
        attention.append(f"`{noisy[0][0]}` có {noisy[0][1]} sự cố trong {hours}h — cân nhắc postmortem tổng hợp")
    data = {
        "window_hours": hours, "generated_at": datetime.fromtimestamp(now, VN).isoformat(timespec="minutes"),
        "incidents": {"new": len(new), "open": len(still_open), "resolved": len(resolved),
                      "mttr_median_s": round(statistics.median(mttr), 1) if mttr else None},
        "noisy_services": [{"service": s, "incidents": n} for s, n in noisy],
        "alerts_correlated": ev.get("alert_correlated", 0),
        "actions": [{"type": a["type"], "status": a["status"], "count": int(a["n"])} for a in actions],
        "agent": {"investigations": len(invs),
                  "grounding_mean": round(statistics.mean(float(r["grounding"]) for r in invs), 3) if invs else None,
                  "cost_usd": round(sum(float(c.get("usd", 0)) for c in costs), 4)},
        "attention": attention,
    }
    md = [f"🗂 *Bàn giao ca trực* — {hours}h qua (đến {data['generated_at']})", "",
          f"• Sự cố mới {len(new)} · đang mở {len(still_open)} · đã đóng {len(resolved)} · MTTR trung vị "
          f"{_fmt_dur(data['incidents']['mttr_median_s'])}",
          f"• Alert đã gộp theo topology: {data['alerts_correlated']}"]
    if noisy:
        md.append("• Ồn nhất: " + ", ".join(f"{s} ({n})" for s, n in noisy))
    if data["actions"]:
        md.append("• Khắc phục: " + ", ".join(f"{a['type']}/{a['status']} ×{a['count']}" for a in data["actions"]))
    if invs:
        md.append(f"• Tác tử: {len(invs)} lần điều tra, grounding TB {data['agent']['grounding_mean']:.0%}, "
                  f"chi phí ${data['agent']['cost_usd']}")
    md += ["", "*Cần chú ý:*"] + ([f"– {a}" for a in attention] or ["– không có"])
    data["markdown"] = "\n".join(md)
    return data
