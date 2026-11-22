"""SLA người bán: uptime tháng (giờ VN) vs cam kết → bậc hoàn phí; áp dụng gọi kế toán đúng tham số, chặn tháng chưa kết thúc."""

import json
from datetime import datetime, timedelta, timezone

import httpx
from fastapi.testclient import TestClient

from aiops.agent.store import IncidentStore
from aiops.statuspage import month_sla

VN = timezone(timedelta(hours=7))
OCT10 = datetime(2026, 10, 10, 9, tzinfo=VN).timestamp()
NOV5 = datetime(2026, 11, 5, tzinfo=VN).timestamp()
COMPS = [{"id": "checkout", "name": "Đặt hàng & thanh toán", "services": ["order", "payment"]},
         {"id": "seller", "name": "Kênh người bán", "services": ["seller"]}, {"id": "browse", "name": "Duyệt", "services": ["catalog"]}]
SLA = {"checkout": {"target": 0.995, "credits": [[0.995, 0.10], [0.99, 0.25], [0.95, 0.50]]},
       "seller": {"target": 0.99, "credits": [[0.99, 0.05]]}}


def _seed(st):
    st.create_incident(service="payment", namespace="shopnow", severity="critical", title="x", source="t",
                       detected_at=OCT10, fault_start=OCT10, resolved_at=OCT10 + 5 * 3600, status="resolved")


def test_month_sla_tiers(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 's.db'}")
    _seed(st)
    r = month_sla(st, COMPS, SLA, "2026-10", NOV5)
    by = {i["component"]: i for i in r["items"]}
    assert r["final"] and r["days_counted"] == 31 and "browse" not in by           # không có cam kết → không xét
    assert by["checkout"]["uptime"] == round(1 - 300 / (31 * 1440), 6) and by["checkout"]["minutes_lost"] == 300.0
    assert by["checkout"]["met"] is False and by["checkout"]["credit_pct"] == 0.10
    assert by["seller"]["met"] is True and by["seller"]["credit_pct"] == 0.0
    # tháng đang chạy: chưa chốt
    assert month_sla(st, COMPS, SLA, "2026-11", NOV5)["final"] is False
    # thêm 24h gián đoạn: 29h / 744h → uptime ≈ 96,1% (< 99% nhưng ≥ 95%) → bậc hoàn 25%
    st.create_incident(service="order", namespace="shopnow", severity="critical", title="y", source="t",
                       detected_at=OCT10 + 86400, fault_start=OCT10 + 86400, resolved_at=OCT10 + 2 * 86400, status="resolved")
    assert {i["component"]: i for i in month_sla(st, COMPS, SLA, "2026-10", NOV5)["items"]}["checkout"]["credit_pct"] == 0.25


def test_apply_calls_accounting(tmp_path):
    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    sent = []

    def acct(req: httpx.Request):
        sent.append((req.url.path, req.headers.get("x-internal-token"), json.loads(req.content)))
        return httpx.Response(201, json={"created": True, "entryNo": "BT-202611-000009", "total": 143000, "shops": []})

    import os
    os.environ["INTERNAL_TOKEN"] = "it"
    try:
        s = load_settings()
        s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'a.db'}", str(tmp_path / "a.jsonl"), False
        app = create_app(s, prom=None, loki=None, inspector=StaticInspector(), backend=RecordingBackend(),
                         notifier=Notifier("", "", enabled=False), llm=NoneProvider(), clock=lambda: NOV5,
                         accounting_transport=httpx.MockTransport(acct))
        with TestClient(app) as c:
            _seed(c.app.state.responder.store)
            rep = c.get("/sla/report").json()                                   # mặc định tháng trước
            assert rep["period"] == "2026-10"
            assert c.post("/sla/credits/2026-11/apply").status_code == 409       # tháng chưa kết thúc
            r = c.post("/sla/credits/2026-10/apply", headers={"x-actor": "cfo@shopnow.local"}).json()
            assert [a["component"] for a in r["applied"]] == ["checkout"]
            path, tok, body = sent[0]
            assert path == "/internal/sla-credits" and tok == "it" and len(sent) == 1
            assert body["pct"] == 0.10 and body["target"] == 0.995 and body["actor"] == "aiops:cfo@shopnow.local"
    finally:
        os.environ.pop("INTERNAL_TOKEN")
