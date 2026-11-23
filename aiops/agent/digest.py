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


def build(store, now: float, hours: int = 24, impact_fn=None, autonomy: dict | None = None) -> dict:
    """`impact_fn(inc) → dict` (agent/impact.py) — có thì quy các sự cố đã đóng trong ca ra đơn/GMV ước mất.
    `autonomy` (autonomy.report) — có thì nhắc luật đủ thành tích bỏ duyệt tay / phải trả về duyệt tay, toil vượt ngân sách."""
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
    if autonomy:
        if autonomy.get("demote"):
            attention.append(f"luật tự động hay hỏng, nên trả về duyệt tay: {', '.join(autonomy['demote'])}")
        if autonomy.get("promote"):
            attention.append(f"luật đủ thành tích để bỏ duyệt tay (xem bản vá ở tab Tự động hoá): {', '.join(autonomy['promote'])}")
        if autonomy.get("toil_over_budget"):
            attention.append(f"toil chiếm {round(autonomy['toil_share'] * 100)}% giờ trực — vượt ngân sách SRE")
    from ..action_items import view as ai_view

    od = [i for i in (ai_view(x, now) for x in store.action_items()) if i["overdue"]]
    if od:
        attention.append(f"{len(od)} việc sau sự cố đã quá hạn (P1: {sum(i['priority'] == 'P1' for i in od)}) — xem tab Vấn đề")
    if noisy and noisy[0][1] >= 3:
        attention.append(f"`{noisy[0][0]}` có {noisy[0][1]} sự cố trong {hours}h — cân nhắc postmortem tổng hợp")
    data = {
        "window_hours": hours, "generated_at": datetime.fromtimestamp(now, VN).isoformat(timespec="minutes"),
        "incidents": {"new": len(new), "open": len(still_open), "resolved": len(resolved),
                      "drill": sum(1 for i in new if i.get("drill_id")),
                      "mttr_median_s": round(statistics.median(mttr), 1) if mttr else None},
        "noisy_services": [{"service": s, "incidents": n} for s, n in noisy],
        "alerts_correlated": ev.get("alert_correlated", 0),
        "actions": [{"type": a["type"], "status": a["status"], "count": int(a["n"])} for a in actions],
        "agent": {"investigations": len(invs),
                  "grounding_mean": round(statistics.mean(float(r["grounding"]) for r in invs), 3) if invs else None,
                  "cost_usd": round(sum(float(c.get("usd", 0)) for c in costs), 4)},
        "attention": attention,
    }
    if impact_fn is not None:
        costed, skipped = [], 0
        for i in resolved[:20]:          # giới hạn số truy vấn Prometheus mỗi bản tin
            imp = impact_fn(i) or {}
            if not imp.get("available") or imp.get("confidence") == "low":
                skipped += 1
                continue
            costed.append({"id": i["id"], "service": i["service"], "orders_lost": imp["orders_lost"], "gmv_lost_vnd": imp["gmv_lost_vnd"]})
        costed.sort(key=lambda x: -x["gmv_lost_vnd"])
        data["business_impact"] = {"gmv_lost_vnd": sum(x["gmv_lost_vnd"] for x in costed),
                                   "orders_lost": round(sum(x["orders_lost"] for x in costed), 1),
                                   "incidents_costed": len(costed), "skipped_low_confidence": skipped, "top": costed[:3]}
    md = [f"🗂 *Bàn giao ca trực* — {hours}h qua (đến {data['generated_at']})", "",
          f"• Sự cố mới {len(new)} · đang mở {len(still_open)} · đã đóng {len(resolved)} · MTTR trung vị "
          f"{_fmt_dur(data['incidents']['mttr_median_s'])}"
          + (f" (trong đó {data['incidents']['drill']} sự cố do diễn tập)" if data["incidents"]["drill"] else ""),
          f"• Alert đã gộp theo topology: {data['alerts_correlated']}"]
    if noisy:
        md.append("• Ồn nhất: " + ", ".join(f"{s} ({n})" for s, n in noisy))
    if data["actions"]:
        md.append("• Khắc phục: " + ", ".join(f"{a['type']}/{a['status']} ×{a['count']}" for a in data["actions"]))
    if invs:
        md.append(f"• Tác tử: {len(invs)} lần điều tra, grounding TB {data['agent']['grounding_mean']:.0%}, "
                  f"chi phí ${data['agent']['cost_usd']}")
    bi = data.get("business_impact")
    if bi and bi["incidents_costed"]:
        from .impact import vnd

        top = bi["top"][0]
        md.append(f"• Ước mất: {bi['orders_lost']:g} đơn ≈ {vnd(bi['gmv_lost_vnd'])} GMV "
                  f"(đắt nhất: {top['service']} {vnd(top['gmv_lost_vnd'])})"
                  + (f"; {bi['skipped_low_confidence']} sự cố không ước lượng tin cậy được" if bi["skipped_low_confidence"] else ""))
    md += ["", "*Cần chú ý:*"] + ([f"– {a}" for a in attention] or ["– không có"])
    data["markdown"] = "\n".join(md)
    return data
