"""Tình báo mối đe doạ cho quản lý lỗ hổng theo rủi ro (risk-based vulnerability management).

CVSS chỉ nói lỗ hổng NGHIÊM TRỌNG tới đâu nếu bị khai thác, không nói nó CÓ đang bị khai thác hay không. Hai nguồn mở bổ sung:
  CISA KEV   danh mục lỗ hổng ĐÃ bị khai thác ngoài thực tế (Known Exploited Vulnerabilities) — kèm ngày đưa vào danh mục
             và cờ dùng trong chiến dịch ransomware.
  FIRST EPSS xác suất một CVE bị khai thác trong 30 ngày tới (0–1) + phân vị so với mọi CVE, cập nhật hằng ngày.

Chỉ lưu cho đúng các CVE đang có trên workload (bảng threat_intel nhỏ), làm mới tối đa mỗi ngày một lần. Lỗi mạng → giữ dữ
liệu cũ (fail-safe): mất nguồn tình báo thì quay về SLA theo mức độ, không bao giờ nới lỏng hạn đã tính.
"""

from __future__ import annotations

import datetime as dt

KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
EPSS_URL = "https://api.first.org/data/v1/epss"
DAY = 86400.0
BATCH = 100


def parse_kev(doc: dict) -> dict[str, dict]:
    out = {}
    for v in doc.get("vulnerabilities") or []:
        cve = v.get("cveID")
        if cve:
            out[cve] = {"kev_added": v.get("dateAdded"), "kev_ransomware": v.get("knownRansomwareCampaignUse") or "Unknown"}
    return out


def parse_epss(doc: dict) -> dict[str, dict]:
    out = {}
    for r in doc.get("data") or []:
        try:
            out[r["cve"]] = {"epss": float(r["epss"]), "epss_percentile": float(r["percentile"])}
        except (KeyError, TypeError, ValueError):
            continue
    return out


def kev_epoch(date: str | None) -> float | None:
    try:
        return dt.datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() if date else None
    except ValueError:
        return None


def refresh(store, fetch, now: float, max_age: float = DAY, force: bool = False) -> dict:
    """fetch(url, params) -> dict JSON. Trả tóm tắt; lỗi từng nguồn được ghi lại nhưng không chặn nguồn kia."""
    cves = sorted({f["vuln_id"] for f in store.vuln_findings(open_only=True) if str(f["vuln_id"]).startswith("CVE-")})
    intel = store.threat_intel()
    last = max((float(r["updated_at"]) for r in intel.values() if r.get("updated_at")), default=0.0)
    if not cves or (not force and set(cves) <= set(intel) and now - last < max_age):
        return {"refreshed": False, "cves": len(cves), "updated_at": last or None}
    rows: dict[str, dict] = {c: {} for c in cves}
    errors = []
    try:
        kev = parse_kev(fetch(KEV_URL, None))
        for c in cves:   # có trong lần tải thành công → cập nhật cả cờ 0 (CVE có thể bị gỡ khỏi danh mục, hiếm)
            rows[c].update({"kev": 1, **kev[c]} if c in kev else {"kev": 0, "kev_added": None, "kev_ransomware": None})
    except Exception as e:  # noqa: BLE001 - mạng/định dạng: giữ giá trị cũ
        errors.append(f"kev: {str(e)[:120]}")
    for i in range(0, len(cves), BATCH):
        part = cves[i:i + BATCH]
        try:
            got = parse_epss(fetch(EPSS_URL, {"cve": ",".join(part)}))
            for c in part:
                rows[c].update(got.get(c) or {"epss": None, "epss_percentile": None})
        except Exception as e:  # noqa: BLE001
            errors.append(f"epss: {str(e)[:120]}")
    store.put_threat_intel({c: f for c, f in rows.items() if f}, now)
    return {"refreshed": True, "cves": len(cves), "kev": sum(1 for f in rows.values() if f.get("kev") == 1),
            "epss_high": sum(1 for f in rows.values() if (f.get("epss") or 0) >= 0.1), "errors": errors, "updated_at": now}


def http_fetch(timeout: float = 20.0):
    import httpx

    def fetch(url: str, params: dict | None) -> dict:
        r = httpx.get(url, params=params, timeout=timeout, headers={"User-Agent": "shopnow-aiops/1.0"})
        r.raise_for_status()
        return r.json()

    return fetch
