"""SLA khắc phục lỗ hổng cho workload ĐANG CHẠY (DevSecOps): CI chỉ quét lúc build; CVE công bố SAU khi deploy thì chỉ
quét liên tục (Trivy Operator → VulnerabilityReport) mới thấy.

  sync     mỗi giờ: phát hiện (container × CVE × package) mới → first_seen; không còn → resolved_at; xuất hiện lại (vd rollback
           về image cũ) → mở lại GIỮ first_seen — rollback không "reset đồng hồ SLA".
  report   SLA vá: CRITICAL 7 ngày, HIGH 30 ngày, CHỈ tính lỗ hổng ĐÃ CÓ bản sửa (chưa có bản sửa → theo dõi, không phạt);
           MTTR vá lỗ hổng (resolved − first_seen) — chỉ số DevSecOps.
  ưu tiên  theo rủi ro thật (threatintel.py): CISA KEV (đang bị khai thác) → P1, hạn 3 ngày tính từ lúc VÀO danh mục (nếu
           vào sau khi phát hiện); EPSS ≥ 0.1 → hạn tối đa 7 ngày. Hạn chỉ bị RÚT NGẮN, không bao giờ nới so với mức độ.
           KEV mà chưa có bản sửa → cờ cần biện pháp tạm (mitigation: chặn đường vào, tắt tính năng, WAF).
"""

from __future__ import annotations

import re
import statistics

DAY = 86400.0
SLA_DAYS = {"CRITICAL": 7, "HIGH": 30}
POLICY = {"kev_days": 3, "epss_threshold": 0.1, "epss_days": 7}


def normalize(reports: list[dict]) -> list[dict]:
    out = []
    for r in reports:
        lab = (r.get("metadata") or {}).get("labels") or {}
        rep = r.get("report") or {}
        art = rep.get("artifact") or {}
        image = f"{art.get('repository', '?')}:{art.get('tag', '')}".rstrip(":")
        # Trivy Operator gắn report vào ReplicaSet (<service>-<pod-template-hash>) — tên ĐỔI sau mỗi deploy. Khoá theo tên
        # ReplicaSet thì mỗi lần deploy lại (dù không vá gì) sẽ "đóng" rồi mở lại mọi lỗ hổng → RESET đồng hồ SLA.
        # Khoá theo service (bỏ hậu tố hash): lỗ hổng chỉ được tính đã vá khi THỰC SỰ biến mất khỏi image mới.
        name = lab.get("trivy-operator.resource.name", "?")
        if lab.get("trivy-operator.resource.kind") == "ReplicaSet":
            name = re.sub(r"-[a-z0-9]{5,10}$", "", name)
        wl = name
        for v in rep.get("vulnerabilities") or []:
            out.append({"workload": wl, "container": lab.get("trivy-operator.container.name", ""), "image": image,
                        "vuln_id": v.get("vulnerabilityID"), "severity": (v.get("severity") or "UNKNOWN").upper(),
                        "pkg": v.get("resource", ""), "installed": v.get("installedVersion", ""),
                        "fixed": v.get("fixedVersion") or "", "title": (v.get("title") or "")[:200]})
    return out


def _key(f: dict) -> str:
    return f"{f['workload']}|{f['container']}|{f['vuln_id']}|{f['pkg']}"


def sync(store, reports: list[dict], now: float) -> dict:
    found = {_key(f): f for f in normalize(reports) if f["vuln_id"]}
    opened = {f["id"] for f in store.vuln_findings(open_only=True)}
    known = {f["id"] for f in store.vuln_findings()}
    for k, f in found.items():
        store.upsert_vuln(k, f, now)
    resolved = [k for k in opened if k not in found]
    for k in resolved:
        store.resolve_vuln(k, now)
    return {"open": len(found), "new": len([k for k in found if k not in known]), "resolved": len(resolved),
            "reopened": len([k for k in found if k in known and k not in opened])}


def _deadline(f: dict, intel: dict | None, sla: dict, pol: dict) -> tuple[float | None, str, list[str]]:
    """(hạn vá epoch, ưu tiên P1/P2/P3, lý do). Hạn = sớm nhất trong các quy tắc áp được."""
    first = float(f["first_seen"])
    base = sla.get(f["severity"])
    cands, why = [], []
    if base is not None:
        cands.append(first + base * DAY)
        why.append(f"{f['severity']} {base} ngày")
    kev = bool(intel and intel.get("kev"))
    epss = float(intel["epss"]) if intel and intel.get("epss") is not None else None
    if kev:
        from .threatintel import kev_epoch

        start = max(first, kev_epoch(intel.get("kev_added")) or first)   # vào KEV sau khi phát hiện → đếm từ ngày vào KEV
        cands.append(start + pol["kev_days"] * DAY)
        why.append(f"CISA KEV {pol['kev_days']} ngày" + (" · ransomware" if intel.get("kev_ransomware") == "Known" else ""))
    if epss is not None and epss >= pol["epss_threshold"]:
        cands.append(first + pol["epss_days"] * DAY)
        why.append(f"EPSS {epss:.2f} ≥ {pol['epss_threshold']} → {pol['epss_days']} ngày")
    prio = "P1" if kev else "P2" if f["severity"] == "CRITICAL" or (epss is not None and epss >= pol["epss_threshold"]) else "P3"
    return (min(cands) if cands else None), prio, why


def report(store, now: float, sla_days: dict | None = None, policy: dict | None = None) -> dict:
    sla = {**SLA_DAYS, **(sla_days or {})}
    pol = {**POLICY, **(policy or {})}
    intel = store.threat_intel()
    items = []
    by_sev: dict[str, int] = {}
    by_prio: dict[str, int] = {}
    breaches: dict[str, int] = {}
    for f in store.vuln_findings(open_only=True):
        age = (now - float(f["first_seen"])) / DAY
        ti = intel.get(f["vuln_id"])
        deadline, prio, why = _deadline(f, ti, sla, pol)
        fixable = bool(f["fixed"])
        breach = bool(deadline is not None and fixable and now > deadline)
        by_sev[f["severity"]] = by_sev.get(f["severity"], 0) + 1
        by_prio[prio] = by_prio.get(prio, 0) + 1
        if breach:
            breaches[f["severity"]] = breaches.get(f["severity"], 0) + 1
        kev = bool(ti and ti.get("kev"))
        items.append({**{k: f[k] for k in ("workload", "container", "image", "vuln_id", "severity", "pkg", "installed", "fixed", "title")},
                      "age_days": round(age, 1), "priority": prio, "reasons": why,
                      "sla_days": None if deadline is None else round((deadline - float(f["first_seen"])) / DAY, 1),
                      "kev": kev, "kev_ransomware": bool(ti and ti.get("kev_ransomware") == "Known"),
                      "epss": None if not ti or ti.get("epss") is None else round(float(ti["epss"]), 4),
                      "epss_percentile": None if not ti or ti.get("epss_percentile") is None else round(float(ti["epss_percentile"]), 3),
                      "fixable": fixable, "breach": breach, "needs_mitigation": kev and not fixable,
                      "due_in_days": None if deadline is None or not fixable else round((deadline - now) / DAY, 1)})
    fixed = [float(f["resolved_at"]) - float(f["first_seen"]) for f in store.vuln_findings() if f.get("resolved_at")]
    items.sort(key=lambda x: (not x["breach"], x["priority"], x["due_in_days"] if x["due_in_days"] is not None else 1e9, -x["age_days"]))
    updated = max((float(r["updated_at"]) for r in intel.values() if r.get("updated_at")), default=None)
    return {"sla_days": sla, "policy": pol, "open_by_severity": by_sev, "open_by_priority": by_prio, "breaches": breaches,
            "kev_open": sum(1 for i in items if i["kev"]), "needs_mitigation": sum(1 for i in items if i["needs_mitigation"]),
            "threat_intel_updated_at": updated,
            "mttr_days": round(statistics.median(fixed) / DAY, 1) if fixed else None, "items": items[:200]}
