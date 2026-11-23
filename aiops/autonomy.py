"""Quyền tự động theo thành tích (earned autonomy) + đo toil (Google SRE, chương "Eliminating Toil").

Luật runbook mới viết luôn để `approval: required` — người duyệt từng lần. Lâu dần người trực bấm "Duyệt" theo phản xạ
(approval fatigue): duyệt tay mà không thật sự xem thì vừa chậm vừa không an toàn hơn. Ngược lại, luật đã `auto` có thể
xuống cấp (hạ tầng đổi, hành động không còn hiệu quả) mà không ai để ý. Module này đo thành tích TỪNG LUẬT trên dữ liệu thật:

  nâng lên auto   ≥ min_samples lần được quyết, 0 lần bị từ chối, thực thi thành công ≥ 95%, sự cố tái diễn trên cùng
                  service trong 2 giờ ≤ 10%, và loại hành động nằm trong danh sách được phép tự động (restart, scale_up).
                  rollback / toggle_flag KHÔNG bao giờ tự nâng: rollback đổi phiên bản đang chạy, toggle_flag đi qua PR GitOps.
  hạ về required  luật auto (có hành động thật, không phải notify) thất bại/bị chặn > 10% hoặc tái diễn > 30%.

Đề xuất chỉ là bản vá aiops/config/runbook.yaml để người review — thay đổi mức tự động là thay đổi chính sách, phải qua PR.

Toil = phút người làm tay lặp lại: chờ duyệt (decided − created) + xử lý sự cố mà luật chỉ thông báo (resolved − acknowledged).
Nhóm sự cố lặp ≥ 3 lần trong cửa sổ theo (service, alertname) mà chỉ có người xử lý → ứng viên viết luật/tự động hoá mới,
xếp theo tổng phút toil. Tỉ lệ toil so với giờ trực (mỗi người 40 giờ/tuần) — mục tiêu SRE: dưới 50%.
"""

from __future__ import annotations

import re
import statistics

DAY = 86400.0
POLICY = {"min_samples": 10, "min_success": 0.95, "max_recurrence": 0.10, "demote_failure": 0.10, "demote_recurrence": 0.30,
          "demote_min_samples": 5, "recurrence_window_s": 7200, "promotable": ["restart", "scale_up"], "toil_budget": 0.5}
DECIDED = ("approved", "rejected", "executed", "failed", "denied", "dry_run")


def _alertname(inc: dict) -> str:
    for a in inc.get("alerts") or []:
        if a.get("alertname"):
            return a["alertname"]
    return inc.get("title") or "?"


def _recurred(inc: dict, incidents: list[dict], window: float) -> bool:
    t = inc.get("mitigated_at") or inc.get("resolved_at")
    if t is None:
        return False
    return any(o["id"] != inc["id"] and o["service"] == inc["service"] and t < o["detected_at"] <= t + window for o in incidents)


def report(store, rules: list[dict], now: float, days: int = 28, policy: dict | None = None, oncall_people: int = 0) -> dict:
    pol = {**POLICY, **(policy or {})}
    since = now - days * DAY
    incidents = store.list_incidents(since=since - DAY, limit=100000, exclude_drills=True)
    by_id = {i["id"]: i for i in incidents}
    actions = [a for a in store.list_actions(since) if a["incident_id"] in by_id]   # bỏ hành động của buổi diễn tập
    out_rules, toil_s = [], 0.0
    for rule in rules:
        mine = [a for a in actions if a.get("rule") == rule["name"]]
        decided = [a for a in mine if a.get("decided_at") is not None and a["status"] in DECIDED]
        rejected = [a for a in mine if a["status"] == "rejected"]
        ran = [a for a in mine if a["status"] in ("executed", "failed", "denied")]
        ok = [a for a in ran if a["status"] == "executed"]
        rec = [a for a in ok if _recurred(by_id[a["incident_id"]], incidents, pol["recurrence_window_s"])]
        waits = [a["decided_at"] - a["created_at"] for a in decided]
        toil_s += sum(w for w in waits if w > 0)
        success = len(ok) / len(ran) if ran else None
        recurrence = len(rec) / len(ok) if ok else None
        cur = rule.get("approval", "required")
        rec_to, why = None, []
        if cur == "required" and rule["action"] != "notify":
            if rule["action"] not in pol["promotable"]:
                why.append(f"{rule['action']} không thuộc nhóm được tự động ({', '.join(pol['promotable'])})")
            elif len(decided) < pol["min_samples"]:
                why.append(f"mới {len(decided)}/{pol['min_samples']} lần quyết")
            elif rejected:
                why.append(f"{len(rejected)} lần bị từ chối")
            elif success is None or success < pol["min_success"]:
                why.append(f"thành công {0 if success is None else round(success * 100)}% < {round(pol['min_success'] * 100)}%")
            elif recurrence is not None and recurrence > pol["max_recurrence"]:
                why.append(f"tái diễn {round(recurrence * 100)}% > {round(pol['max_recurrence'] * 100)}%")
            else:
                rec_to = "auto"
                why.append(f"{len(decided)} lần duyệt, 0 từ chối, thành công {round(success * 100)}%, tái diễn "
                           f"{round((recurrence or 0) * 100)}%")
        elif cur == "auto" and rule["action"] != "notify" and len(ran) >= pol["demote_min_samples"]:
            fail = 1 - (success or 0)
            if fail > pol["demote_failure"] or (recurrence or 0) > pol["demote_recurrence"]:
                rec_to = "required"
                why.append(f"thất bại {round(fail * 100)}%, tái diễn {round((recurrence or 0) * 100)}% — trả về duyệt tay")
        out_rules.append({
            "rule": rule["name"], "action": rule["action"], "approval": cur, "actions": len(mine), "decided": len(decided),
            "rejected": len(rejected), "executed": len(ok), "failed": len(ran) - len(ok),
            "success_rate": None if success is None else round(success, 3),
            "recurrence_rate": None if recurrence is None else round(recurrence, 3),
            "median_wait_s": round(statistics.median(waits), 1) if waits else None,
            "recommendation": rec_to, "reasons": why})
    # sự cố chỉ có người xử lý (luật notify hoặc không có hành động thực thi) → toil + ứng viên tự động hoá
    executed_inc = {a["incident_id"] for a in actions if a["status"] == "executed"}
    groups: dict[tuple, dict] = {}
    for inc in incidents:
        if inc["detected_at"] < since or inc["id"] in executed_inc or not inc.get("resolved_at"):
            continue
        start = inc.get("acknowledged_at") or inc["detected_at"]
        minutes = max(0.0, inc["resolved_at"] - start) / 60
        toil_s += minutes * 60
        g = groups.setdefault((inc["service"], _alertname(inc)), {"service": inc["service"], "alertname": _alertname(inc),
                                                                   "count": 0, "toil_minutes": 0.0})
        g["count"] += 1
        g["toil_minutes"] += minutes
    cands = sorted((g for g in groups.values() if g["count"] >= 3), key=lambda g: -g["toil_minutes"])
    for g in cands:
        g["toil_minutes"] = round(g["toil_minutes"], 1)
    oncall_h = oncall_people * 40 * days / 7
    share = (toil_s / 3600) / oncall_h if oncall_h else None
    return {"days": days, "policy": pol, "rules": out_rules,
            "promote": [r["rule"] for r in out_rules if r["recommendation"] == "auto"],
            "demote": [r["rule"] for r in out_rules if r["recommendation"] == "required"],
            "toil_hours": round(toil_s / 3600, 2), "oncall_hours": round(oncall_h, 1) if oncall_h else None,
            "toil_share": None if share is None else round(share, 3),
            "toil_over_budget": bool(share is not None and share > pol["toil_budget"]),
            "automation_candidates": cands[:20]}


def patch_runbook(text: str, rule: str, approval: str) -> str:
    """Đổi ĐÚNG dòng `approval:` trong khối luật `rule` (giữ chú thích, thứ tự, định dạng)."""
    lines, inside, done = text.splitlines(), False, False
    for i, ln in enumerate(lines):
        m = re.match(r"^\s*-\s+name:\s*(\S+)", ln)
        if m:
            inside = m.group(1) == rule
            continue
        if inside and re.match(r"^\s+approval:\s*\w+", ln):
            lines[i] = re.sub(r"approval:\s*\w+", f"approval: {approval}", ln, count=1)
            done = True
            break
    if not done:
        raise KeyError(rule)
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")
