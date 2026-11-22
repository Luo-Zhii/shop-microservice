"""Right-sizing: quy tắc đề xuất (p95×1.2, đỉnh RAM×1.15, giảm ≤ 50%/lần, không vượt limit, cần ≥ 3 ngày), tiền tiết kiệm,
bản vá YAML + cổng xác minh, endpoint mở PR GitOps."""

import base64
import difflib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from aiops.rightsizing import MI, analyze, patch_requests, recommend_one, verify_patch

V = {  # (container → giá trị) theo từng loại truy vấn
    "quantile_over_time": {"catalog": 0.02, "order": 0.19, "review": 0.01},
    "max_over_time": {"catalog": 70 * MI, "order": 300 * MI, "review": 30 * MI},
    "count_over_time": {"catalog": 7, "order": 7, "review": 1},          # đã là số ngày (PromQL tự chia /24)
    'resource="cpu"': {"catalog": 0.15, "order": 0.2, "review": 0.1},
    'resource="memory"}) ': {}, "requests{": {}, "limits": {"catalog": 384 * MI, "order": 384 * MI, "review": 384 * MI},
    "kube_pod_container_info": {"catalog": 2, "order": 3, "review": 1},
}
REQ_MEM = {"catalog": 192 * MI, "order": 192 * MI, "review": 160 * MI}


def _prom():
    from aiops.collectors.prometheus import PrometheusClient

    def handler(req):
        q = req.url.params["query"]
        if "kube_pod_container_resource_requests" in q:
            vals = V['resource="cpu"'] if 'resource="cpu"' in q else REQ_MEM
        elif "kube_pod_container_resource_limits" in q:
            vals = V["limits"]
        else:
            vals = next(v for k, v in V.items() if k in q)
        res = [{"metric": {"container": c}, "value": [0, str(x)]} for c, x in vals.items()]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})
    return PrometheusClient("http://p", transport=httpx.MockTransport(handler))


def test_recommend_rules():
    r = recommend_one(0.02, 70 * MI, 0.15, 192 * MI, 384 * MI)
    assert r["cpu"] == 0.075 and r["mem"] == 96 * MI and r["staged"] is True        # nấc 50%, còn giảm tiếp được
    up = recommend_one(0.19, 360 * MI, 0.2, 192 * MI, 384 * MI)
    assert up["mem"] == 384 * MI and up["mem_capped_at_limit"] and up["change_cpu"] == 0.0   # CPU +15% < 25% → giữ
    assert recommend_one(0.1, 100 * MI, 0.11, 110 * MI, None)["actionable"] is False


def test_analyze_savings_and_data_gate():
    r = analyze(_prom())
    by = {i["service"]: i for i in r["items"]}
    c = by["catalog"]
    assert c["direction"] == "decrease" and c["recommended"] == {"cpu_m": 75, "mem_mi": 96} and c["staged"]
    expect = ((0.15 - 0.075) * 0.031611 + (96 / 1024) * 0.004237) * 2 * 730
    assert c["monthly_saving_usd"] == round(expect, 2) and r["monthly_saving_usd"] == pytest.approx(expect + by["order"]["monthly_saving_usd"], abs=0.02)
    assert by["order"]["direction"] == "increase" and by["order"]["recommended"]["mem_mi"] == 352 and by["order"]["monthly_saving_usd"] < 0
    assert by["review"]["enough_data"] is False and by["review"]["direction"] == "keep"
    assert r["items"][-1]["direction"] == "keep"


def test_patch_and_verify():
    src = "name: catalog\nresources:\n  requests: {cpu: 150m, memory: 192Mi}\n  limits: {cpu: \"1\", memory: 384Mi}\n"
    after = patch_requests(src, 75, 96)
    assert "  requests: {cpu: 75m, memory: 96Mi}" in after and "limits: {cpu: \"1\", memory: 384Mi}" in after
    diff = "".join(difflib.unified_diff(src.splitlines(True), after.splitlines(True), "a/f", "b/f"))
    path, cur = "apps/shopnow/services/catalog.yaml", {"cpu_m": 150, "mem_mi": 192}
    assert verify_patch(diff, path, "catalog", cur) == []
    too_much = "".join(difflib.unified_diff(src.splitlines(True), patch_requests(src, 50, 96).splitlines(True), "a/f", "b/f"))
    assert "giảm quá 50%" in " ".join(verify_patch(too_much, path, "catalog", cur))
    sneaky = diff + "+replicaCount: 0\n"
    assert any("ngoài requests" in p for p in verify_patch(sneaky, path, "catalog", cur))
    assert verify_patch(diff, "apps/shopnow/services/order.yaml", "catalog", cur)
    # service đang dùng mức chung → thêm khối resources riêng
    assert patch_requests("name: review\nport: 8111\n", 60, 64).endswith("resources:\n  requests: {cpu: 60m, memory: 64Mi}   # right-sizing (AIOps)\n")


def test_propose_pr_endpoint(tmp_path):
    from aiops.agent.gitops_pr import GitHubGitOps
    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    src = "name: catalog\nport: 8103\nresources:\n  requests: {cpu: 150m, memory: 192Mi}\n  limits: {cpu: \"1\", memory: 512Mi}\n"
    calls = []

    def gh(req: httpx.Request):
        calls.append((req.method, req.url.path, req.content))
        if req.method == "GET" and "/contents/" in req.url.path:
            return httpx.Response(200, json={"content": base64.b64encode(src.encode()).decode(), "sha": "s1"})
        if req.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "b"}})
        if req.url.path.endswith("/pulls"):
            return httpx.Response(201, json={"number": 9, "html_url": "https://github.com/x/shop-gitops/pull/9"})
        return httpx.Response(201, json={})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'r.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=_prom(), loki=None, inspector=StaticInspector(), backend=RecordingBackend(),
                     notifier=Notifier("", "", enabled=False), llm=NoneProvider(),
                     gitops=GitHubGitOps("x/shop-gitops", "t", transport=httpx.MockTransport(gh)))
    with TestClient(app) as c:
        assert c.get("/finops/rightsizing").json()["items"][0]["service"] == "catalog"
        r = c.post("/finops/rightsizing/catalog/propose-pr", headers={"x-actor": "sre@shopnow.local"}).json()
        assert r["status"] == "proposed" and r["url"].endswith("/pull/9") and "giảm requests" in r["title"]
        put = next(json.loads(b) for m, p, b in calls if m == "PUT")
        body = base64.b64decode(put["content"]).decode()
        assert "requests: {cpu: 75m, memory: 96Mi}" in body and "memory: 512Mi" in body
        assert c.post("/finops/rightsizing/review/propose-pr").status_code == 409        # thiếu dữ liệu
