import json

import httpx
import numpy as np

from aiops.alerting import AlertmanagerClient
from aiops.collectors.loki import LokiClient
from aiops.collectors.prometheus import PrometheusClient
from aiops.collectors.service_graph import build_graph
from aiops.config import load_settings
from aiops.engine import DetectorEngine
from aiops.eval.simulator import SERVICES, simulate


def test_prometheus_range_by_label_aligns_grid():
    def h(req):
        assert req.url.path == "/api/v1/query_range"
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix", "result": [
            {"metric": {"service": "order"}, "values": [[1000, "0.5"], [1060, "NaN"], [1090, "0.7"]]}]}})

    p = PrometheusClient("http://prom", transport=httpx.MockTransport(h))
    grid, series = p.range_by_label("x", 1000, 1090, 30)
    assert len(grid) == 4 and series["order"][0] == 0.5 and np.isnan(series["order"][1]) and series["order"][3] == 0.7


def test_loki_query_range():
    def h(req):
        assert req.url.params["query"] == '{namespace="shopnow"}'
        return httpx.Response(200, json={"status": "success", "data": {"result": [
            {"stream": {"service": "order"}, "values": [["2000000000", "b"], ["1000000000", "a"]]}]}})

    rows = LokiClient("http://loki", transport=httpx.MockTransport(h)).query_range('{namespace="shopnow"}', 0, 3)
    assert [r[2] for r in rows] == ["a", "b"]


def test_service_graph_from_traces_merges_async_edges():
    def h(req):
        return httpx.Response(200, json={"status": "success", "data": {"result": [
            {"metric": {"client": "api-gateway", "server": "catalog"}, "value": [0, "12.5"]}]}})

    s = load_settings()
    g, src = build_graph(PrometheusClient("http://p", transport=httpx.MockTransport(h)), s.raw["graph"], s.services)
    assert src == "traces" and g.edges["api-gateway", "catalog"]["rps"] == 12.5 and g.has_edge("order", "payment")
    g2, src2 = build_graph(PrometheusClient("http://p", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"status": "success", "data": {"result": []}}))), s.raw["graph"], s.services)
    assert src2 == "static" and g2.has_edge("order", "catalog")


def test_engine_scores_and_pushes_alert_with_source_label():
    s = load_settings()
    s.raw["logs"]["enabled"] = False
    sc = simulate(0, np.random.default_rng(3), T=240, kind="fault", fault="error", root="catalog")
    posted = []
    am = AlertmanagerClient("http://am", transport=httpx.MockTransport(
        lambda r: posted.append(json.loads(r.content)) or httpx.Response(200)))
    eng = DetectorEngine(s, prom=None, loki=None, alerts=am)
    t_end = sc.t0 + 6
    now = 1_700_000_000.0
    sent = []
    for t in (t_end - 2, t_end - 1, t_end):
        data = {svc: {k: v[: t + 1] for k, v in sc.raw[svc].items()} for svc in SERVICES}
        snap = eng.evaluate(now + t * 30, data=data, log_lines=[])
        sent += eng.alert_step(snap)
    assert snap.services["catalog"].score > 0.6
    fired = [a for a in sent if a["labels"]["service"] == "catalog"]
    assert fired and fired[0]["labels"]["source"] == "aiops" and fired[0]["labels"]["env"] == "dev"
    assert posted and posted[0][0]["labels"]["alertname"] == "AIOpsAnomaly"
    assert snap.services["catalog"].onset <= now + t_end * 30


def test_kpi_anomalies_business_and_ux():
    """Đơn/giây sụt (HTTP vẫn bình thường) và LCP vượt ngưỡng ở service chỉ có RUM → điểm bất thường + top feature KPI."""
    from aiops.detection.kpi import kpi_scores, robust_z

    rng = np.random.default_rng(1)
    s = load_settings()
    s.raw["logs"]["enabled"] = False
    eng = DetectorEngine(s, prom=None, loki=None, alerts=None)
    T = 120
    orders = 5 + rng.normal(0, 0.3, T)
    orders[-5:] = 0.4                     # checkout hỏng logic: gần như không ai đặt được đơn
    lcp = 1.8 + rng.normal(0, 0.05, T)
    lcp[-5:] = 5.5                        # trang chậm phía trình duyệt
    flat = {k: np.full(T, v) for k, v in (("rps", 50.0), ("p95", 0.12), ("err", 0.001), ("cpu", 0.2), ("mem", 200.0), ("dlq", 0.0))}
    data = {"order": {**{k: v + rng.normal(0, v * 0.02 + 1e-6, T) for k, v in flat.items()}, "orders": orders},
            "web": {"lcp": lcp, "jserr": np.full(T, 0.01)}}
    snap = eng.evaluate(1_700_000_000.0, data=data, log_lines=[])
    assert snap.services["order"].score >= 0.6 and snap.services["order"].top_features[0][0] == "orders"
    assert snap.services["web"].score >= 0.6 and snap.services["web"].top_features[0][0] == "lcp"
    # LCP tăng nhưng vẫn dưới ngưỡng good 2.5s → không tính; đơn tăng (chiều tốt) → không tính
    ok_lcp = 1.2 + rng.normal(0, 0.02, T)
    ok_lcp[-5:] = 2.0
    assert kpi_scores({"lcp": ok_lcp}, {"lcp": {"direction": "up", "min_level": 2.5}}, slice(0, 100))[0] == 0.0
    up_orders = orders.copy()
    up_orders[-5:] = 20
    assert kpi_scores({"orders": up_orders}, {"orders": {"direction": "down"}}, slice(0, 100))[0] == 0.0
    assert robust_z(np.full(50, 3.0), slice(0, 40)) == 0.0   # chuỗi phẳng: không chia cho 0
