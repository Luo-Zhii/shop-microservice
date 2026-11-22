"""Dự báo ngày cạn error budget: Theil–Sen bền với bước nhảy, ETA đúng, không giảm → không ETA; /slo/status tích hợp."""

import httpx
import numpy as np
from fastapi.testclient import TestClient

from aiops.slo_forecast import eta_hours, theil_sen

NOW = 1_800_000_000.0


def test_theil_sen_robust_and_eta():
    x = np.arange(25, dtype=float)
    y = 0.60 - 0.01 * x                     # mất 1% budget mỗi giờ
    y_spike = y.copy(); y_spike[10] = 0.0   # một điểm nhiễu tụt sâu không làm lệch độ dốc
    assert abs(theil_sen(x, y_spike) - (-0.01)) < 1e-9
    r = eta_hours(x * 3600, y)
    assert r["slope_per_day"] == -0.24 and r["eta_hours"] == 36.0 and r["points"] == 25   # 0.36 còn lại / 0.01 mỗi giờ
    assert eta_hours(x * 3600, np.full(25, 0.8))["eta_hours"] is None                       # không giảm
    assert eta_hours(x * 3600, 0.1 + 0.001 * x)["eta_hours"] is None                       # đang hồi phục
    assert eta_hours(x[:2] * 3600, y[:2])["slope_per_day"] is None                         # quá ít điểm


def test_slo_status_uses_forecast(tmp_path):
    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    def prom(req):
        q = req.url.params.get("query", "")
        if req.url.path.endswith("/query_range"):
            start, step = float(req.url.params["start"]), float(req.url.params["step"])
            vals = [[start + i * step, str(0.70 - 0.0125 * i)] for i in range(25)]    # còn 0.40, giảm 1.25%/giờ → 32h
            res = [{"metric": {"sloth_slo": "checkout-availability"}, "values": vals}]
            return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix", "result": res}})
        v = {"slo:objective:ratio": 0.995, "slo:current_burn_rate:ratio": 0.8, "slo:period_burn_rate:ratio": 0.9,
             "slo:period_error_budget_remaining:ratio": 0.40}.get(q)
        res = [{"metric": {"sloth_slo": "checkout-availability"}, "value": [0, str(v)]}] if v is not None else []
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'f.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=PrometheusClient("http://p", transport=httpx.MockTransport(prom)), loki=None,
                     inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                     llm=NoneProvider(), clock=lambda: NOW)
    with TestClient(app) as c:
        it = c.get("/slo/status").json()["items"][0]
        # burn hiện tại < 1, budget 40% (> 25%) — trước đây là "healthy"; dự báo cạn sau 32h → "at_risk"
        assert it["budget_eta_hours"] == 32.0 and it["state"] == "at_risk" and it["budget_slope_per_day"] == -0.3
        assert 'aiops_slo_budget_eta_hours{slo="checkout-availability"} 32.0' in c.get("/metrics").text


def test_range_grid_keeps_latest_point():
    """Hồi quy: lưới cũ np.arange(start, end + 1e-9) làm rơi điểm MỚI NHẤT (1e-9 < độ phân giải float64 ở epoch ~1.8e9)."""
    from aiops.collectors.prometheus import PrometheusClient

    def prom(req):
        start, step = float(req.url.params["start"]), float(req.url.params["step"])
        vals = [[start + i * step, str(i)] for i in range(25)]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix",
                                                                       "result": [{"metric": {"service": "x"}, "values": vals}]}})

    grid, s = PrometheusClient("http://p", transport=httpx.MockTransport(prom)).range_by_label("q", NOW - 86400, NOW, 3600)
    assert len(grid) == 25 and grid[-1] == NOW and s["x"][-1] == 24.0
