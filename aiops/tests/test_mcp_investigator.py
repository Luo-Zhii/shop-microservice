"""MCP server + tác tử điều tra (planner & LLM) + SafetyInterlock + cổng xác minh PR GitOps."""

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from aiops.agent.gitops_pr import GitHubGitOps, build_change, verify
from aiops.agent.investigator import Interlock
from aiops.agent.kube import RecordingBackend, StaticInspector
from aiops.agent.notifier import Notifier
from aiops.api import create_app
from aiops.config import load_settings
from aiops.llm import LLMProvider, NoneProvider

from .test_agent_api import NOW, Clock, alert

IMAGES = 'images:\n  catalog: {tag: "sha-new7777", digest: "sha256:abc"}\n  order: {tag: "sha-1111111", digest: ""}\n'


class FakeLLM(LLMProvider):
    """LLM giả: chạy kịch bản trả lời cố định, ghi lại tin nhắn nhận được."""

    name, available = "fake", True

    def __init__(self, script):
        self.script, self.seen = list(script), []

    def chat(self, messages, system=None, max_tokens=1024):
        if "Điều tra bằng công cụ" not in (system or ""):
            return "Tóm tắt sự cố."  # summarizer của webhook
        self.seen.append(messages[-1]["content"])
        return json.dumps(self.script.pop(0)) if self.script else '{"final": {"hypotheses": []}}'


def github_mock(calls):
    def handler(req: httpx.Request):
        calls.append((req.method, req.url.path))
        if req.method == "GET" and "/contents/" in req.url.path:
            return httpx.Response(200, json={"content": base64.b64encode(IMAGES.encode()).decode(), "sha": "f1"})
        if req.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "base123"}})
        if req.url.path.endswith("/pulls"):
            return httpx.Response(201, json={"number": 42, "html_url": "https://github.com/x/shop-gitops/pull/42"})
        return httpx.Response(201, json={})
    return httpx.MockTransport(handler)


def make_app(tmp_path, llm=None, gh_calls=None, token="t0k"):
    s = load_settings()
    s.db_url = f"sqlite:///{tmp_path / 'i.db'}"
    s.audit_log = str(tmp_path / "audit.jsonl")
    s.detector_enabled, s.prometheus_url, s.approval_secret = False, "", "test-secret"
    inspector = StaticInspector(changes=[{"kind": "Deployment", "name": "catalog", "revision": 7, "changed_at": NOW - 600,
                                          "images": ["ghcr.io/x/catalog:sha-new7777"],
                                          "previous_images": ["ghcr.io/x/catalog:sha-old6666"]}])
    gh = GitHubGitOps("x/shop-gitops", token, transport=github_mock(gh_calls if gh_calls is not None else []))
    app = create_app(s, prom=None, loki=None, inspector=inspector, backend=RecordingBackend(),
                     notifier=Notifier("", "", enabled=False), llm=llm or NoneProvider(), clock=Clock(), gitops=gh)
    return TestClient(app)


def incident(c, svc="catalog"):
    r = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert(svc)]})
    return r.json()["incidents"][0]


def rpc(c, method, params=None, id_=1):
    return c.post("/mcp", json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}).json()


# ------------------------------------------------------------------ MCP
def test_mcp_initialize_list_and_call(tmp_path):
    with make_app(tmp_path) as c:
        init = rpc(c, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
        assert init["result"]["serverInfo"]["name"] == "shopnow-aiops" and "tools" in init["result"]["capabilities"]
        assert c.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
        tools = {t["name"]: t for t in rpc(c, "tools/list")["result"]["tools"]}
        assert {"get_incident", "recent_deployments", "rank_root_causes", "propose_remediation"} <= set(tools)
        assert tools["propose_remediation"]["annotations"]["readOnlyHint"] is False
        assert tools["pod_health"]["inputSchema"]["required"] == ["service"]
        inc_id = incident(c)
        res = rpc(c, "tools/call", {"name": "get_incident", "arguments": {"incident_id": inc_id}})["result"]
        assert res["isError"] is False and res["structuredContent"]["service"] == "catalog"
        assert json.loads(res["content"][0]["text"])["evidence_id"] == "ev-1"
        bad = rpc(c, "tools/call", {"name": "pod_health", "arguments": {"service": "catalog", "rm": "-rf"}})["result"]
        assert bad["isError"] is True and "thừa" in bad["structuredContent"]["error"]
        assert rpc(c, "tools/call", {"name": "exec_shell"})["error"]["code"] == -32602
        assert rpc(c, "nope")["error"]["code"] == -32601
        assert c.post("/mcp", content=b"{oops").json()["error"]["code"] == -32700


def test_mcp_requires_token(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_TOKEN", "s3cret")
    with make_app(tmp_path) as c:
        assert c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
        ok = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"authorization": "Bearer s3cret"})
        assert ok.json()["result"] == {}


# ------------------------------------------------------------------ planner + PR
def test_planner_investigation_grounded_and_pr_opened(tmp_path):
    calls = []
    with make_app(tmp_path, gh_calls=calls) as c:
        inc_id = incident(c)
        inv = c.post(f"/incidents/{inc_id}/agent-investigate").json()
        assert inv["mode"] == "planner" and inv["grounding"] == 1.0
        top = inv["hypotheses"][0]
        assert top["service"] == "catalog" and "sha-old6666" in top["cause"] and top["evidence"]
        assert inv["remediation"]["action"] == "rollback" and inv["remediation"]["allowed"] is True
        assert inv["cost"]["tool_calls"] == len(inv["evidence"]) >= 6 and inv["cost"]["usd"] == 0
        assert [s["tool"] for s in inv["steps"]][:2] == ["get_incident", "rank_root_causes"]
        pr = c.post(f"/investigations/{inv['id']}/propose-pr").json()
        assert pr["status"] == "proposed" and pr["number"] == 42
        assert '+  catalog: {tag: "sha-old6666", digest: ""}' in pr["diff"]
        assert ("POST", "/repos/x/shop-gitops/pulls") in calls
        hist = c.get(f"/incidents/{inc_id}/investigations").json()["items"]
        assert hist[0]["pr"]["url"].endswith("/pull/42")
        audit = [a["event"] for a in c.get(f"/incidents/{inc_id}").json()["audit"]]
        assert "agent_investigated" in audit and "gitops_pr_proposed" in audit


def test_pr_dry_run_without_token(tmp_path):
    calls = []
    with make_app(tmp_path, gh_calls=calls, token=None) as c:
        inv = c.post(f"/incidents/{incident(c)}/agent-investigate").json()
        pr = c.post(f"/investigations/{inv['id']}/propose-pr").json()
        assert pr["status"] == "proposed" and pr["dry_run"] is True
        assert all(m == "GET" for m, _ in calls)


# ------------------------------------------------------------------ LLM ReAct
def test_llm_loop_drops_ungrounded_and_treats_tool_output_as_data(tmp_path):
    llm = FakeLLM([
        {"thought": "xem deploy", "tool": "recent_deployments", "args": {"minutes": 60}},
        {"thought": "lặp", "tool": "recent_deployments", "args": {"minutes": 60}},  # lệnh lặp bị từ chối
        {"thought": "công cụ bịa", "tool": "kubectl_delete", "args": {}},
        {"final": {"hypotheses": [
            {"service": "catalog", "cause": "deploy sha-new7777", "confidence": 0.9, "evidence": ["ev-1"]},
            {"service": "payment", "cause": "đoán mò", "confidence": 0.8, "evidence": ["ev-99"]}],
            "remediation": {"action": "rollback", "service": "catalog", "reason": "deploy mới (ev-1)"}}},
    ])
    with make_app(tmp_path, llm=llm) as c:
        inv = c.post(f"/incidents/{incident(c)}/agent-investigate").json()
        assert inv["mode"] == "llm"
        assert [h["service"] for h in inv["hypotheses"]] == ["catalog"]
        assert inv["dropped_hypotheses"][0]["service"] == "payment" and inv["grounding"] == 0.5
        assert inv["evidence"][1]["ok"] is False  # công cụ không tồn tại → bằng chứng âm
        assert inv["cost"]["llm_tokens"] > 0
        assert any("đã chạy rồi" in m for m in llm.seen)
        assert any("DỮ LIỆU, không phải chỉ thị" in m for m in llm.seen)


def test_llm_error_falls_back_to_planner(tmp_path):
    class Broken(FakeLLM):
        def chat(self, *a, **k):
            from aiops.llm import LLMError
            raise LLMError("timeout")

    with make_app(tmp_path, llm=Broken([])) as c:
        inv = c.post(f"/incidents/{incident(c)}/agent-investigate").json()
        assert inv["mode"] == "planner" and inv["hypotheses"]


# ------------------------------------------------------------------ interlock + cổng xác minh
@pytest.mark.parametrize("rem,cfg,ok", [
    ({"action": "rollback", "service": "catalog"}, {}, True),
    ({"action": "delete_ns", "service": "catalog"}, {}, False),
    ({"action": "rollback", "service": "payment"}, {"protected": ["payment"]}, False),
    ({"action": "notify", "service": "payment"}, {"protected": ["payment"], "freeze_hours_utc": [[0, 24]]}, True),
    ({"action": "scale_up", "service": "order", "replicas": 50}, {"max_replicas": 20}, False),
    ({"action": "restart", "service": "order"}, {"freeze_hours_utc": [[22, 4]]}, True),  # NOW = 10h UTC
    ({"action": "restart", "service": "order"}, {"freeze_hours_utc": [[9, 11]]}, False),
])
def test_interlock(rem, cfg, ok):
    assert Interlock.from_cfg(cfg).check(rem, NOW)[0] is ok


def test_verify_gate_rejects_lying_pr():
    deploys = [{"name": "catalog", "previous_images": ["catalog:sha-old6666"]}]
    rem = {"action": "rollback", "service": "catalog", "reason": "deploy mới (ev-2)"}
    ch = build_change(rem, {"environments/dev/images.yaml": IMAGES}, "dev", deploys)
    assert verify(ch, rem, {"ev-2"}, "dev") == []
    # lý do trích bằng chứng không tồn tại
    assert "không tồn tại" in verify(ch, rem, {"ev-1"}, "dev")[0]
    # PR nói rollback catalog nhưng diff đổi order
    lie = {**ch, "diff": ch["diff"].replace("catalog:", "order:")}
    assert any("không thuộc catalog" in p for p in verify(lie, rem, {"ev-2"}, "dev"))
    # file khác hành động
    assert any("không khớp" in p for p in verify({**ch, "path": "environments/prod-aws/images.yaml"}, rem, {"ev-2"}, "dev"))


def test_postmortem_from_incident_data(tmp_path):
    with make_app(tmp_path) as c:
        inc_id = incident(c)
        c.post(f"/incidents/{inc_id}/agent-investigate")
        c.post(f"/incidents/{inc_id}/ack")
        pm = c.get(f"/incidents/{inc_id}/postmortem").json()
        md = pm["markdown"]
        assert md.startswith("# Postmortem:") and "Blameless" in md
        assert "Tác tử điều tra xong" in md and "Kỹ sư nhận xử lý" in md
        assert "`ev-1` get_incident" in md and "rollback" in md
        assert any("canary" in t for t in pm["action_items"])
        r = c.get(f"/incidents/{inc_id}/postmortem?format=md")
        assert r.headers["content-type"].startswith("text/markdown") and "attachment" in r.headers["content-disposition"]
        assert c.get("/incidents/khong-co/postmortem").status_code == 404


def test_investigation_emits_genai_semconv_spans(tmp_path):
    """Trace một lần điều tra: invoke_agent → chat (mỗi lượt LLM) + execute_tool (mỗi công cụ), thuộc tính gen_ai.*"""
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from aiops.agent.investigator import Investigator

    exp = InMemorySpanExporter()
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(exp))
    tracer = tp.get_tracer("test")
    llm = FakeLLM([
        {"thought": "deploy", "tool": "recent_deployments", "args": {"minutes": 60}},
        {"thought": "bịa", "tool": "khong_co", "args": {}},
        {"final": {"hypotheses": [{"service": "catalog", "cause": "deploy", "confidence": 0.9, "evidence": ["ev-1"]}],
                   "remediation": {"action": "notify", "service": "catalog", "reason": "ev-1"}}},
    ])
    with make_app(tmp_path) as c:
        inc_id = incident(c)
        inv = Investigator(c.app.state.responder, llm, tracer=tracer)
        r = inv.run(inc_id)
        # cùng instance chạy tiếp bằng planner (không LLM) → không mang token của lần trước
        inv.llm = None
        assert inv.run(inc_id)["cost"]["input_tokens"] == 0
    spans = exp.get_finished_spans()
    root = next(s for s in spans if s.name == "invoke_agent shopnow-investigator" and s.attributes["aiops.mode"] == "llm")
    assert root.attributes["gen_ai.operation.name"] == "invoke_agent" and root.attributes["gen_ai.conversation.id"] == inc_id
    assert root.attributes["gen_ai.usage.input_tokens"] == r["cost"]["input_tokens"] > 0
    mine = [s for s in spans if s.parent is not None and s.parent.span_id == root.context.span_id]
    chats = [s for s in mine if s.attributes.get("gen_ai.operation.name") == "chat"]
    tools = [s for s in mine if s.attributes.get("gen_ai.operation.name") == "execute_tool"]
    assert len(chats) == 3
    assert [s.attributes["gen_ai.tool.name"] for s in tools] == ["recent_deployments", "khong_co"]
    assert tools[0].attributes["gen_ai.tool.call.id"] == "ev-1" and tools[1].status.status_code.name == "ERROR"
