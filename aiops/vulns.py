"""SLA khắc phục lỗ hổng cho workload ĐANG CHẠY (DevSecOps): CI chỉ quét lúc build; CVE công bố SAU khi deploy thì chỉ
quét liên tục (Trivy Operator → VulnerabilityReport) mới thấy.

  sync     mỗi giờ: phát hiện (container × CVE × package) mới → first_seen; không còn → resolved_at; xuất hiện lại (vd rollback
           về image cũ) → mở lại GIỮ first_seen — rollback không "reset đồng hồ SLA".
  report   SLA vá: CRITICAL 7 ngày, HIGH 30 ngày, CHỈ tính lỗ hổng ĐÃ CÓ bản sửa (chưa có bản sửa → theo dõi, không phạt);
           MTTR vá lỗ hổng (resolved − first_seen) — chỉ số DevSecOps.
"""

from __future__ import annotations

import re
import statistics

DAY = 86400.0
SLA_DAYS = {"CRITICAL": 7, "HIGH": 30}


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


def report(store, now: float, sla_days: dict | None = None) -> dict:
    sla = {**SLA_DAYS, **(sla_days or {})}
    items = []
    by_sev: dict[str, int] = {}
    breaches: dict[str, int] = {}
    for f in store.vuln_findings(open_only=True):
        age = (now - float(f["first_seen"])) / DAY
        limit = sla.get(f["severity"])
        fixable = bool(f["fixed"])
        breach = bool(limit is not None and fixable and age > limit)
        by_sev[f["severity"]] = by_sev.get(f["severity"], 0) + 1
        if breach:
            breaches[f["severity"]] = breaches.get(f["severity"], 0) + 1
        items.append({**{k: f[k] for k in ("workload", "container", "image", "vuln_id", "severity", "pkg", "installed", "fixed", "title")},
                      "age_days": round(age, 1), "sla_days": limit, "fixable": fixable, "breach": breach,
                      "due_in_days": None if limit is None or not fixable else round(limit - age, 1)})
    fixed = [float(f["resolved_at"]) - float(f["first_seen"]) for f in store.vuln_findings() if f.get("resolved_at")]
    items.sort(key=lambda x: (not x["breach"], x["severity"] != "CRITICAL", -(x["age_days"])))
    return {"sla_days": sla, "open_by_severity": by_sev, "breaches": breaches,
            "mttr_days": round(statistics.median(fixed) / DAY, 1) if fixed else None, "items": items[:200]}
