"""Ảnh hưởng kinh doanh: hụt so với trung vị hôm qua/tuần trước, trừ mua bù 1 giờ, × AOV 7 ngày; mốc lệch → tin cậy thấp."""

import httpx
from fastapi.testclient import TestClient

from aiops.agent.impact import estimate
from aiops.collectors.prometheus import PrometheusClient

T0 = 1_800_000_000.0
END = T0 + 1800


def _prom(values):
    def handler(req):
        q = req.url.params["query"]
        key = ("gmv" if "order_gmv" in q else "n") + ":" + q.split("[")[1].split("s]")[0] + ":" + (
            "1d" if "offset 1d" in q else "1w" if "offset 1w" in q else "now")
        v = values.get(key)
        res = [] if v is None else [{"metric": {}, "value": [0, str(v)]}]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})
    return PrometheusClient("http://p", transport=httpx.MockTransport(handler))


BASE = {"n:1800:now": 20, "n:1800:1d": 100, "n:1800:1w": 120,         # trong sự cố: 20 so với kỳ vọng 110
        "n:3600:now": 70, "n:3600:1d": 40, "n:3600:1w": 40,           # 1 giờ sau: mua bù 30
        "gmv:604800:now": 4_000_000_000, "n:604800:now": 10_000}     # AOV 400k


def test_net_loss_after_rebound():
    r = estimate(_prom(BASE), T0, END, now=END + 7200, default_aov=1)
    assert r["orders_expected"] == 110 and r["orders_deficit"] == 90 and r["orders_rebound"] == 30
    assert r["orders_lost"] == 60 and r["aov_vnd"] == 400_000 and r["gmv_lost_vnd"] == 24_000_000
    assert r["confidence"] == "medium" and r["rebound_measured"] and r["drop_ratio"] == 0.818


def test_rebound_not_measured_yet_and_fallback_aov():
    vals = {k: v for k, v in BASE.items() if not k.startswith("gmv")}
    r = estimate(_prom(vals), T0, END, now=END + 600, default_aov=350_000)
    assert r["rebound_measured"] is False and r["orders_lost"] == 90 and r["gmv_lost_vnd"] == 90 * 350_000
    assert r["aov_source"] == "cấu hình mặc định" and "chưa đo mua bù" in r["note"]


def test_low_confidence_and_missing_data():
    skew = {**BASE, "n:1800:1d": 300}          # hôm qua trùng flash sale → hai mốc lệch nhau > 50%
    assert estimate(_prom(skew), T0, END, now=END + 7200)["confidence"] == "low"
    assert estimate(_prom({}), T0, END, now=END)["available"] is False
    more = {**BASE, "n:1800:now": 200}          # đơn nhiều hơn kỳ vọng → không có thiệt hại
    assert estimate(_prom(more), T0, END, now=END + 7200)["gmv_lost_vnd"] == 0


def test_impact_endpoint_and_postmortem(tmp_path):
    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'm.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=_prom(BASE), loki=None, inspector=StaticInspector(), backend=RecordingBackend(),
                     notifier=Notifier("", "", enabled=False), llm=NoneProvider(), clock=lambda: END + 7200)
    with TestClient(app) as c:
        inc = c.app.state.responder.store.create_incident(service="order", namespace="shopnow", severity="critical", title="Đơn giảm",
                                                          source="test", detected_at=T0 + 120, fault_start=T0, resolved_at=END,
                                                          status="resolved")
        r = c.get(f"/incidents/{inc['id']}/impact").json()
        assert r["gmv_lost_vnd"] == 24_000_000 and r["ongoing"] is False
        pm = c.get(f"/incidents/{inc['id']}/postmortem").json()
        assert "## Ảnh hưởng kinh doanh (ước lượng)" in pm["markdown"] and "24.000.000 đ" in pm["markdown"]
        assert pm["action_items"][0].startswith("Ước mất 60 đơn")

        dg = c.get("/reports/oncall-digest?hours=24").json()
        assert dg["business_impact"]["gmv_lost_vnd"] == 24_000_000 and dg["business_impact"]["top"][0]["service"] == "order"
        assert "Ước mất: 60 đơn ≈ 24.000.000 đ GMV" in dg["markdown"]
