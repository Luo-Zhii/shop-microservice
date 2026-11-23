"""Postmortem không đổ lỗi (blameless, theo mẫu Google SRE) sinh tự động từ dữ liệu sự cố.

Mọi câu trong báo cáo đều đến từ bản ghi: mốc thời gian, audit, hành động, bản điều tra của tác tử (giả thuyết kèm evidence).
Không dùng LLM để tránh bịa. Phần "bài học" và "việc cần làm" sinh theo luật từ dữ liệu, để kỹ sư sửa tiếp.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

VN = timezone(timedelta(hours=7))
EVENT_VI = {
    "incident_created": "Tạo sự cố từ cảnh báo", "alert_merged": "Gộp thêm cảnh báo", "investigated": "RCA tự động xong",
    "investigate_failed": "RCA tự động lỗi", "notified": "Đã thông báo kênh trực", "agent_investigated": "Tác tử điều tra xong",
    "incident_acknowledged": "Kỹ sư nhận xử lý", "action_approved": "Duyệt hành động", "action_rejected": "Từ chối hành động",
    "incident_resolved": "Đóng sự cố", "rca_evaluated": "Chấm RCA theo nguyên nhân thật", "fault_start_set": "Ghi mốc lỗi bắt đầu",
    "gitops_pr_proposed": "Mở PR GitOps", "gitops_pr_rejected": "Cổng xác minh chặn PR", "gitops_pr_skipped": "Không cần PR",
    "execute": "Executor thực thi khắc phục (xem kết quả ở mục Hành động)",
}


def _t(ts) -> str:
    if ts is None:
        return "—"
    if isinstance(ts, str):
        ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    return datetime.fromtimestamp(float(ts), VN).strftime("%d/%m %H:%M:%S")


def _dur(a, b) -> str:
    if a is None or b is None:
        return "—"
    s = int(float(b) - float(a))
    return f"{s // 3600}h{s % 3600 // 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s"


def build(inc: dict, actions: list[dict], audit: list[dict], investigations: list[dict], impact: dict | None = None,
          tracked: list[dict] | None = None) -> dict:
    inv = investigations[0] if investigations else None
    start = inc.get("fault_start") or inc.get("detected_at")
    timings = {
        "MTTD (lỗi → phát hiện)": _dur(inc.get("fault_start"), inc.get("detected_at")),
        "TTA (phát hiện → nhận)": _dur(inc.get("detected_at"), inc.get("acknowledged_at")),
        "TTM (lỗi → giảm thiểu)": _dur(start, inc.get("mitigated_at")),
        "MTTR (lỗi → khôi phục)": _dur(start, inc.get("resolved_at")),
    }
    root = (inv["hypotheses"][0] if inv and inv.get("hypotheses") else None)
    rca = (inc.get("root_causes") or [{}])[0].get("service")
    lines = [f"# Postmortem: {inc.get('title') or inc['service']}", "",
             f"*Blameless: báo cáo mô tả hệ thống và quy trình, không quy lỗi cá nhân. Sinh tự động lúc {_t(datetime.now().timestamp())}"
             " từ dữ liệu sự cố — kỹ sư trực rà và bổ sung.*", "",
             "## Tóm tắt", "",
             f"- **Service bị cảnh báo:** `{inc['service']}` · mức `{inc.get('severity')}` · trạng thái `{inc.get('status')}`",
             f"- **Nguyên nhân gốc (RCA đồ thị):** `{rca or '—'}`"]
    if root:
        lines.append(f"- **Kết luận của tác tử:** `{root['service']}`: {root['cause']} (độ tin {root['confidence']:.0%}, "
                     f"bằng chứng {', '.join(root['evidence'])}; chế độ {inv['mode']}, grounding {inv['grounding']:.0%})")
    if inc.get("summary"):
        lines += ["", "> " + inc["summary"].replace("\n", "\n> ")]
    if impact and impact.get("available"):
        from .impact import vnd

        lines += ["", "## Ảnh hưởng kinh doanh (ước lượng)", "",
                  f"- Đơn thực tế **{impact['orders_actual']:g}** so với kỳ vọng **{impact['orders_expected']:g}** "
                  f"(trung vị cùng khung giờ hôm qua/tuần trước: {impact['baselines']}) → hụt {impact['orders_deficit']:g} đơn "
                  f"({(impact['drop_ratio'] or 0):.0%})",
                  f"- Khách mua bù trong 1 giờ sau khôi phục: {impact['orders_rebound']:g} đơn"
                  + ("" if impact["rebound_measured"] else " (chưa đủ 1 giờ để đo)"),
                  f"- **Mất ròng ≈ {impact['orders_lost']:g} đơn × giá trị đơn TB {vnd(impact['aov_vnd'])} "
                  f"= {vnd(impact['gmv_lost_vnd'])} GMV** — độ tin cậy `{impact['confidence']}`: {impact['note']}"]
    lines += ["", "## Chỉ số thời gian", "", "| Chỉ số | Giá trị |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in timings.items()]
    lines += ["", "## Dòng thời gian (giờ VN)", "", "| Lúc | Sự kiện | Bởi |", "|---|---|---|"]
    events = [(inc.get("fault_start"), f"Lỗi bắt đầu ({inc.get('fault_start_source') or 'không rõ nguồn'})", "—")] if inc.get("fault_start") else []
    events += [(a["ts"], EVENT_VI.get(a["event"], a["event"]), a.get("actor") or "—") for a in audit]
    for ts, ev, who in sorted(events, key=lambda x: float(x[0]) if not isinstance(x[0], str) else
                              datetime.fromisoformat(x[0].replace("Z", "+00:00")).timestamp()):
        lines.append(f"| {_t(ts)} | {ev} | {who} |")
    lines += ["", "## Hành động khắc phục", ""]
    lines += [f"- `{a['type']}` {a['target'].get('kind')}/{a['target'].get('name')}: **{a['status']}** "
              f"(luật `{a.get('rule')}`, duyệt bởi {a.get('decided_by') or '—'})" for a in actions] or ["- (không có)"]
    if inv:
        rem = inv["remediation"]
        lines.append(f"- Tác tử đề xuất `{rem['action']}` {rem['service']}: {rem['reason']}"
                     + ("" if rem.get("allowed") else f" — **SafetyInterlock chặn:** {rem.get('interlock')}"))
        if inv.get("pr") and inv["pr"].get("url"):
            lines.append(f"- PR GitOps: {inv['pr']['url']}")
    lines += ["", "## Bằng chứng", ""]
    if inv:
        lines += [f"- `{e['id']}` {e['tool']}({', '.join(f'{k}={v}' for k, v in (e.get('args') or {}).items())})"
                  + ("" if e["ok"] else " — lỗi") for e in inv["evidence"]]
    else:
        lines.append("- Chưa có bản điều tra của tác tử.")
    lines += ["", "## Bài học & việc cần làm", ""]
    todo = []
    if inc.get("fault_start") and inc.get("detected_at") and float(inc["detected_at"]) - float(inc["fault_start"]) > 300:
        todo.append("Phát hiện chậm hơn 5 phút → xem lại ngưỡng detector / SLO burn-rate của service này.")
    if not inc.get("acknowledged_at"):
        todo.append("Không có ai nhận sự cố → kiểm tra lịch trực và kênh thông báo.")
    if root and rca and root["service"] != rca:
        todo.append(f"RCA đồ thị ({rca}) khác kết luận tác tử ({root['service']}) → gửi feedback nguyên nhân thật để chấm lại RCA.")
    if inv and inv.get("dropped_hypotheses"):
        todo.append(f"Tác tử có {len(inv['dropped_hypotheses'])} giả thuyết không bằng chứng bị loại → rà prompt/công cụ.")
    if any(a["type"] == "rollback" for a in actions) or (inv and inv["remediation"]["action"] == "rollback"):
        todo.append("Phải rollback → bổ sung kiểm thử/canary analysis cho thay đổi gây lỗi trước khi lên prod.")
    if inv and not inv["remediation"].get("allowed"):
        todo.append("Interlock chặn hành động tự động → quyết định có mở rộng runbook hay giữ thao tác thủ công.")
    if impact and impact.get("available") and impact["gmv_lost_vnd"] > 0 and impact["confidence"] != "low":
        todo.insert(0, f"Ước mất {impact['orders_lost']:g} đơn — đưa vào ưu tiên backlog độ tin cậy theo giá trị tiền, không chỉ theo cảm giác.")
    if tracked:   # việc đã được nhận theo dõi (action_items.py): trạng thái thật, người phụ trách, hạn, PR/ticket
        lines += ["### Đang theo dõi", ""]
        for it in tracked:
            mark = "x" if it["status"] == "done" else "-" if it["status"] == "wontfix" else " "
            extra = f" — {it['ref']}" if it.get("ref") else f" — không làm: {it['note']}" if it.get("note") and it["status"] == "wontfix" else ""
            lines.append(f"- [{mark}] **{it['priority']}** {it['title']} · {it.get('owner') or 'chưa giao'} · hạn {_t(it['due_at'])}{extra}")
        lines += ["", "### Gợi ý của tác tử", ""]
    lines += [f"- [ ] {t}" for t in todo] or ["- [ ] (bổ sung)"]
    return {"incident_id": inc["id"], "markdown": "\n".join(lines) + "\n", "action_items": todo, "timings": timings,
            "impact": impact}
