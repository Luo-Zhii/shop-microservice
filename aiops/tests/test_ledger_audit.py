"""Kiểm toán sổ cái: Benford, số tròn, ngoài giờ, chi trùng, TK nhạy cảm, tỉ lệ đảo."""

import random

import httpx

from aiops.audit.ledger import audit, benford, fetch_entries


def entry(no, total, source="kafka", at="2026-11-18T03:00:00Z", lines=None, by="event:order"):
    return {"entry_no": no, "seq": int(no.split("-")[-1]), "total": total, "source": source, "created_at": at, "created_by": by,
            "lines": lines or [{"account": "3388", "debit": total, "credit": 0, "party_id": None},
                               {"account": "331", "debit": 0, "credit": total, "party_id": "shop-1"}]}


def benford_amounts(n, rng):
    # log-uniform trên nhiều bậc độ lớn → tuân theo Benford
    return [10 ** rng.uniform(4, 8) for _ in range(n)]


def test_benford_conformity_vs_fabricated():
    rng = random.Random(7)
    assert benford(benford_amounts(3000, rng))["conformity"] in ("close", "acceptable")
    fake = [rng.choice([5, 6, 7, 8, 9]) * 10 ** rng.randint(4, 7) + rng.randint(0, 999) for _ in range(3000)]
    r = benford(fake)
    assert r["conformity"] == "nonconformity" and r["observed"][1] == 0
    assert benford([1, 2, 3])["conformity"] == "insufficient"


def test_rules_detect_manual_anomalies():
    rng = random.Random(1)
    es = [entry(f"BT-202611-{i:06d}", int(a)) for i, a in enumerate(benford_amounts(200, rng), 1)]
    cash = [{"account": "642", "debit": 50_000_000, "credit": 0, "party_id": None},
            {"account": "1111", "debit": 0, "credit": 50_000_000, "party_id": None}]
    es.append(entry("BT-202611-000900", 50_000_000, "manual", "2026-11-21T16:30:00Z", cash, "ketoan@x"))  # 23h30 VN thứ bảy
    pay = [{"account": "331", "debit": 7_250_000, "credit": 0, "party_id": "shop-9"},
           {"account": "1121", "debit": 0, "credit": 7_250_000, "party_id": "shop-9"}]
    es.append(entry("BT-202611-000901", 7_250_000, "payout", "2026-11-18T03:00:00Z", pay))
    es.append(entry("BT-202611-000902", 7_250_000, "payout", "2026-11-18T09:00:00Z", pay))
    r = audit(es)
    rules = {(f["rule"], f["entry_no"]) for f in r["findings"]}
    assert ("round_amount", "BT-202611-000900") in rules
    assert ("off_hours", "BT-202611-000900") in rules
    assert ("sensitive_account", "BT-202611-000900") in rules
    assert ("duplicate", "BT-202611-000902") in rules
    assert ("duplicate", "BT-202611-000901") not in rules
    assert "benford" not in r["by_rule"] and r["manual"] == 1


def test_reversal_rate_and_fetch_pagination():
    es = [entry(f"BT-202611-{i:06d}", 1000 + i) for i in range(1, 31)]
    es += [entry(f"BT-202611-{i:06d}", 500, "reversal") for i in range(31, 36)]
    assert "reversal_rate" in audit(es)["by_rule"]
    pages = []

    def handler(req):
        pages.append(int(req.url.params["sinceSeq"]))
        since = pages[-1]
        items = [entry(f"BT-202611-{i:06d}", 1) for i in range(since + 1, min(since + 1000, 1500) + 1)]
        assert req.headers["x-internal-token"] == "t"
        return httpx.Response(200, json={"items": items})

    out = fetch_entries("http://acc", "t", transport=httpx.MockTransport(handler))
    assert len(out) == 1500 and pages == [0, 1000]
