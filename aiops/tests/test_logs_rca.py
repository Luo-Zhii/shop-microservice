import json

import networkx as nx
import numpy as np

from aiops.collectors.service_graph import static_graph
from aiops.config import load_settings
from aiops.detection.logs import LogAnomalyDetector, parse_line, summarize_errors
from aiops.rca import rank_by_score, rank_root_causes


def test_parse_pino_json():
    line = json.dumps({"level": "error", "msg": "xử lý sự kiện thất bại → DLQ", "err": {"type": "Error", "message": "boom"}})
    msg, lvl = parse_line(line)
    assert lvl == "error" and "DLQ" in msg and "boom" in msg


def test_new_error_template_and_spike():
    det = LogAnomalyDetector(warmup_windows=2)
    base = [("order", json.dumps({"level": "error", "msg": f"timeout calling catalog after {i}ms"})) for i in (100, 200)]
    for _ in range(3):
        f = det.observe(base + [("order", '{"level":"info","msg":"checkout ok id 12"}')], ["order"])
    assert f["order"].score == 0
    spike = [("order", json.dumps({"level": "error", "msg": f"timeout calling catalog after {i}ms"})) for i in range(40)]
    new = [("order", json.dumps({"level": "error", "msg": "pq: connection refused 10.0.0.5:5432"}))] * 3
    f = det.observe(spike + new, ["order"])["order"]
    assert f.spikes and f.new_templates and f.score > 0.6


def test_summarize_errors_groups_templates():
    lines = [f"ERROR payment failed for checkout {i} reason=timeout" for i in range(5)] + ["ERROR db down"]
    top = summarize_errors(lines)
    assert top[0]["count"] == 5 and "<NUM>" in top[0]["template"]


def chain():
    g = nx.DiGraph()
    g.add_edges_from([("api-gateway", "order"), ("order", "catalog"), ("api-gateway", "catalog"), ("api-gateway", "search"),
                      ("catalog", "seller")], kind="sync", weight=1.0)
    return g


def test_rca_prefers_deepest_correlated_anomaly():
    t = np.linspace(0, 1, 20)
    sig = np.where(t > 0.5, 6.0, 0.2) + 0.05 * np.sin(t * 30)
    scores = {"api-gateway": 0.95, "order": 0.9, "catalog": 0.85, "search": 0.1, "seller": 0.05}
    signals = {"api-gateway": sig * 1.1, "order": sig, "catalog": sig * 0.9, "search": np.random.default_rng(0).normal(0, 1, 20),
               "seller": np.zeros(20) + 0.1}
    res = rank_root_causes(chain(), scores, signals)
    assert res[0]["service"] == "catalog"
    assert res[0]["evidence"]["unexplained_by_callees"] is True
    assert rank_by_score(scores, 1) == ["api-gateway"]  # baseline ngây thơ chọn sai


def test_static_graph_from_config_has_saga_edges():
    s = load_settings()
    g = static_graph(s.raw["graph"], s.services)
    assert g.has_edge("api-gateway", "order") and g.has_edge("order", "catalog")
    assert g.edges["order", "inventory"]["kind"] == "async"
    assert set(s.services) <= set(g.nodes)
