"""Gợi ý SLO: bậc số 9 cao nhất mà 90% số ngày đạt; quá chặt / quá lỏng / chưa có (kèm YAML) / thiếu dữ liệu."""

import httpx
import numpy as np
import yaml

from aiops.collectors.prometheus import PrometheusClient
from aiops.slo_suggest import analyze, suggest_objective

NOW = 1_800_000_000.0
DAILY = {
    "catalog": [0.9996] * 28,
    "search": [0.9992] * 23 + [0.995] * 5,
    "warehouse": [0.997] * 28,
    "review": [0.9993] * 28,
    "web": [0.9999] * 3,
}
OBJ = {"catalog-availability": 0.995, "search-availability": 0.999, "warehouse-availability": 0.995}
SLOS = {"catalog-availability": ["catalog"], "search-availability": ["search"], "warehouse-availability": ["warehouse"],
        "checkout-latency": ["order", "payment"]}


def _prom():
    def handler(req):
        if req.url.path.endswith("/query_range"):
            end = float(req.url.params["end"])
            res = [{"metric": {"service": s}, "values": [[end - (len(v) - 1 - i) * 86400, str(x)] for i, x in enumerate(v)]}
                   for s, v in DAILY.items()]
            return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix", "result": res}})
        res = [{"metric": {"sloth_slo": k}, "value": [0, str(v)]} for k, v in OBJ.items()]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})
    return PrometheusClient("http://p", transport=httpx.MockTransport(handler))


def test_suggest_objective_ladder():
    assert suggest_objective(np.array([0.9996] * 28)) == 0.9995
    assert suggest_objective(np.array([0.9992] * 23 + [0.995] * 5)) == 0.995     # 5/28 ngày xấu > 10% → bậc thấp
    assert suggest_objective(np.array([0.98] * 10)) == 0.99                        # dưới mọi bậc → bậc sàn
    assert suggest_objective(np.array([0.999] * 5)) is None                         # < 7 ngày


def test_analyze_verdicts_and_snippet():
    r = analyze(_prom(), NOW, SLOS)
    by = {i["service"]: i for i in r["items"]}
    assert by["catalog"]["verdict"] == "too_loose" and by["catalog"]["suggested"] == 0.9995
    assert by["search"]["verdict"] == "too_strict" and by["search"]["achieved"] < 0.999 and by["search"]["suggested"] == 0.995
    assert by["warehouse"]["verdict"] == "ok"
    assert by["web"]["verdict"] == "insufficient"
    rv = by["review"]
    assert rv["verdict"] == "no_slo" and rv["current"] is None
    doc = yaml.safe_load("slos:\n" + rv["snippet"])                      # đoạn YAML dán thẳng vào file Sloth được
    assert doc["slos"][0]["objective"] == 99.9 and 'service="review"' in doc["slos"][0]["sli"]["events"]["errorQuery"]
    assert [i["verdict"] for i in r["items"]][:2] == ["too_strict", "no_slo"]   # việc cần xử lý lên đầu
