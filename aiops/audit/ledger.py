"""Bộ kiểm toán sổ cái — AIOps áp dụng cho dữ liệu tài chính (FinOps/Audit analytics).

Nguồn: accounting `/internal/journal/export`. Phát hiện:
- benford: phân phối chữ số đầu của số tiền lệch luật Benford (MAD theo Nigrini; > 0.015 = không phù hợp)
- round_amount: bút toán thủ công số tròn lớn (≥ 10 triệu, chia hết 1 triệu) — dấu hiệu ước lượng/gian lận
- off_hours: bút toán thủ công ghi ngoài giờ hành chính (22h–6h giờ VN) hoặc cuối tuần
- sensitive_account: bút toán thủ công chạm tài khoản nhạy cảm (tiền, thuế, doanh thu)
- duplicate: cùng số tiền + cùng đối tượng + cùng tài khoản trong 24h (chi trả trùng)
- reversal_rate: tỉ lệ bút toán đảo cao bất thường
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import httpx

VN = timezone(timedelta(hours=7))
BENFORD = {d: math.log10(1 + 1 / d) for d in range(1, 10)}
SENSITIVE = ("111", "112", "333", "511")


def first_digit(x: float) -> int | None:
    x = abs(x)
    if x < 1:
        return None
    return int(str(int(x))[0])


def benford(amounts: list[float]) -> dict:
    digits = [d for d in (first_digit(a) for a in amounts) if d]
    n = len(digits)
    if n < 50:
        return {"n": n, "mad": None, "conformity": "insufficient", "observed": {}}
    c = Counter(digits)
    obs = {d: c.get(d, 0) / n for d in range(1, 10)}
    mad = sum(abs(obs[d] - BENFORD[d]) for d in range(1, 10)) / 9
    # ngưỡng Nigrini (chữ số đầu): ≤0.006 rất phù hợp, ≤0.012 chấp nhận, ≤0.015 tạm, >0.015 không phù hợp
    level = "close" if mad <= 0.006 else "acceptable" if mad <= 0.012 else "marginal" if mad <= 0.015 else "nonconformity"
    chi2 = sum((c.get(d, 0) - n * BENFORD[d]) ** 2 / (n * BENFORD[d]) for d in range(1, 10))
    return {"n": n, "mad": round(mad, 5), "chi2": round(chi2, 2), "conformity": level,
            "observed": {d: round(obs[d], 4) for d in obs}, "expected": {d: round(BENFORD[d], 4) for d in BENFORD}}


def _ts(e: dict) -> datetime:
    return datetime.fromisoformat(str(e["created_at"]).replace("Z", "+00:00")).astimezone(VN)


def audit(entries: list[dict]) -> dict:
    findings: list[dict] = []
    manual = [e for e in entries if e.get("source") == "manual"]
    for e in manual:
        total = int(e["total"])
        if total >= 10_000_000 and total % 1_000_000 == 0:
            findings.append({"rule": "round_amount", "severity": "medium", "entry_no": e["entry_no"],
                             "detail": f"số tròn {total:,}đ trên bút toán thủ công"})
        t = _ts(e)
        if t.hour >= 22 or t.hour < 6 or t.weekday() >= 5:
            findings.append({"rule": "off_hours", "severity": "low", "entry_no": e["entry_no"],
                             "detail": f"ghi lúc {t:%a %H:%M} giờ VN bởi {e.get('created_by')}"})
        hit = sorted({ln["account"] for ln in e.get("lines", []) if ln["account"].startswith(SENSITIVE)})
        if hit:
            findings.append({"rule": "sensitive_account", "severity": "medium", "entry_no": e["entry_no"],
                             "detail": f"bút toán thủ công chạm TK {', '.join(hit)}"})
    seen: dict[tuple, list[tuple[datetime, str]]] = defaultdict(list)
    for e in entries:
        if e.get("source") not in ("manual", "payout"):
            continue
        flagged = False
        for ln in e.get("lines", []):
            if not ln.get("party_id"):
                continue
            key = (ln["account"], ln.get("party_id"), int(ln["debit"]) or -int(ln["credit"]))
            t = _ts(e)
            for prev_t, prev_no in seen[key]:
                if not flagged and abs((t - prev_t).total_seconds()) <= 86_400 and prev_no != e["entry_no"]:
                    flagged = True
                    findings.append({"rule": "duplicate", "severity": "high", "entry_no": e["entry_no"],
                                     "detail": f"trùng số tiền/đối tượng với {prev_no} trong 24h ({ln['account']} {ln['party_id']})"})
                    break
            seen[key].append((t, e["entry_no"]))
    reversals = sum(1 for e in entries if e.get("source") == "reversal")
    rate = reversals / max(1, len(entries))
    if len(entries) >= 20 and rate > 0.05:
        findings.append({"rule": "reversal_rate", "severity": "medium", "entry_no": None,
                         "detail": f"tỉ lệ bút toán đảo {rate:.1%} > 5%"})
    amounts = [float(ln["debit"]) for e in entries for ln in e.get("lines", []) if float(ln["debit"]) > 0]
    bf = benford(amounts)
    # MAD nhạy với mẫu nhỏ → chỉ báo khi đồng thời chi-bình-phương có ý nghĩa (8 bậc tự do, p<0.01: 20.09)
    if bf["conformity"] == "nonconformity" and bf["chi2"] > 20.09:
        findings.append({"rule": "benford", "severity": "medium", "entry_no": None,
                         "detail": f"chữ số đầu lệch luật Benford (MAD {bf['mad']}, n={bf['n']})"})
    try:
        from ..metrics import LEDGER_FINDINGS

        for f in findings:
            LEDGER_FINDINGS.labels(f["rule"]).inc()
    except Exception:  # noqa: BLE001
        pass
    by_rule = Counter(f["rule"] for f in findings)
    return {"entries": len(entries), "manual": len(manual), "findings": findings, "by_rule": dict(by_rule), "benford": bf}


def fetch_entries(base_url: str, token: str, since_seq: int = 0, transport: httpx.BaseTransport | None = None) -> list[dict]:
    out: list[dict] = []
    with httpx.Client(base_url=base_url, headers={"x-internal-token": token}, timeout=20, transport=transport) as c:
        while True:
            r = c.get("/internal/journal/export", params={"sinceSeq": since_seq, "limit": 1000})
            r.raise_for_status()
            items = r.json()["items"]
            out.extend(items)
            if len(items) < 1000:
                return out
            since_seq = int(items[-1]["seq"])
