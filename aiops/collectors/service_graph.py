"""Đồ thị gọi giữa service.

Nguồn chính: metric `traces_service_graph_request_total{client,server}` (Tempo metrics-generator hoặc
OTel Collector servicegraph connector). Thiếu → đồ thị tĩnh trong config (saga ShopNow).
`traces_spanmetrics_*` dùng làm nguồn RED dự phòng khi service chưa phát http_server_requests_seconds.
"""

from __future__ import annotations

import logging

import networkx as nx

log = logging.getLogger("aiops.service_graph")

SERVICE_GRAPH_Q = "sum by (client, server) (rate(traces_service_graph_request_total[{window}]))"
SERVICE_GRAPH_FAILED_Q = "sum by (client, server) (rate(traces_service_graph_request_failed_total[{window}]))"

# Truy vấn RED dự phòng từ spanmetrics (nhãn service_name → service).
SPANMETRICS_FEATURES = {
    "p95": 'label_replace(histogram_quantile(0.95, sum by (service_name, le) (rate(traces_spanmetrics_latency_bucket{{span_kind="SPAN_KIND_SERVER"}}[{window}]))), "service", "$1", "service_name", "(.*)")',
    "err": 'label_replace(sum by (service_name) (rate(traces_spanmetrics_calls_total{{span_kind="SPAN_KIND_SERVER",status_code="STATUS_CODE_ERROR"}}[{window}])) / clamp_min(sum by (service_name) (rate(traces_spanmetrics_calls_total{{span_kind="SPAN_KIND_SERVER"}}[{window}])), 1e-9), "service", "$1", "service_name", "(.*)")',
    "rps": 'label_replace(sum by (service_name) (rate(traces_spanmetrics_calls_total{{span_kind="SPAN_KIND_SERVER"}}[{window}])), "service", "$1", "service_name", "(.*)")',
}


def static_graph(cfg_graph: dict, services: list[str] | None = None) -> nx.DiGraph:
    g = nx.DiGraph()
    if services:
        g.add_nodes_from(services)
    aw = float(cfg_graph.get("async_weight", 0.3))
    for caller, callees in (cfg_graph.get("sync") or {}).items():
        for c in callees:
            g.add_edge(caller, c, kind="sync", weight=1.0)
    for producer, consumers in (cfg_graph.get("async") or {}).items():
        for c in consumers:
            if not g.has_edge(producer, c):
                g.add_edge(producer, c, kind="async", weight=aw)
    return g


def from_prometheus(prom, window: str = "5m", min_rps: float = 1e-4) -> nx.DiGraph:
    g = nx.DiGraph()
    for s in prom.query(SERVICE_GRAPH_Q.format(window=window)):
        m = s.get("metric", {})
        client, server = m.get("client"), m.get("server")
        try:
            rps = float(s["value"][1])
        except (KeyError, ValueError, IndexError):
            continue
        if client and server and client != server and rps > min_rps:
            g.add_edge(client, server, kind="trace", weight=1.0, rps=rps)
    return g


def build_graph(prom, cfg_graph: dict, services: list[str], window: str = "5m") -> tuple[nx.DiGraph, str]:
    """Đồ thị từ trace (nếu có) hợp với đồ thị tĩnh — cạnh async tĩnh vẫn giữ vì trace Kafka hay bị đứt."""
    base = static_graph(cfg_graph, services)
    if prom is None:
        return base, "static"
    try:
        tg = from_prometheus(prom, window)
    except Exception as e:  # noqa: BLE001
        log.warning("không lấy được service graph, dùng đồ thị tĩnh: %s", e)
        return base, "static"
    if tg.number_of_edges() == 0:
        return base, "static"
    g = nx.DiGraph()
    g.add_nodes_from(services)
    g.add_edges_from(tg.edges(data=True))
    for u, v, d in base.edges(data=True):
        if d.get("kind") == "async" and not g.has_edge(u, v):
            g.add_edge(u, v, **d)
    return g, "traces"
