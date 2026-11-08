import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from aiops.agent.kube import RecordingBackend, StaticInspector
from aiops.agent.notifier import Notifier
from aiops.api import create_app
from aiops.config import load_settings
from aiops.llm import NoneProvider

NOW = 1_794_132_000.0  # 2026-11-08T10:00:00Z


class Clock:
    def __init__(self):
        self.t = NOW

    def __call__(self):
        return self.t


@pytest.fixture()
def env(tmp_path):
    s = load_settings()
    s.db_url = f"sqlite:///{tmp_path / 'i.db'}"
    s.audit_log = str(tmp_path / "audit.jsonl")
    s.detector_enabled, s.prometheus_url, s.approval_secret = False, "", "test-secret"
    s.public_url = "https://aiops.example"
    sent = []

    def tg(req):
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    notifier = Notifier("123:abc", "-100", enabled=True, transport=httpx.MockTransport(tg))
    inspector = StaticInspector(changes=[{"kind": "Deployment", "name": "catalog", "revision": 7, "changed_at": NOW - 600,
                                          "images": ["catalog:v7"], "previous_images": ["catalog:v6"]}])
    backend = RecordingBackend()
    clock = Clock()
    app = create_app(s, prom=None, loki=None, inspector=inspector, backend=backend, notifier=notifier,
                     llm=NoneProvider(), clock=clock)
    with TestClient(app) as c:
        yield c, sent, backend, clock, s


def alert(svc, status="firing", fp=None, starts="2026-11-08T10:00:00.123456789Z", name="HighErrorRate", **lab):
    return {"status": status, "labels": {"alertname": name, "service": svc, "severity": "critical", "namespace": "shopnow",
                                          **lab},
            "annotations": {"summary": f"{svc} lỗi"}, "startsAt": starts, "endsAt": "0001-01-01T00:00:00Z",
            "fingerprint": fp or f"fp-{svc}"}


def test_full_incident_flow_with_approval(env):
    c, sent, backend, clock, s = env
    # 2 alert: triệu chứng ở gateway + order, gốc là catalog (vừa deploy)
    r = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [
        alert("catalog"), alert("api-gateway"), alert("order")]})
    assert r.status_code == 200
    ids = r.json()["incidents"]
    inc = c.get(f"/incidents/{ids[0]}").json()
    assert inc["service"] == "catalog" and inc["detected_at"] == "2026-11-08T10:00:00.123456Z"
    assert inc["root_causes"][0]["service"] == "catalog"
    assert inc["decision"]["action"] == "rollback" and "catalog" in inc["summary"]
    act = inc["actions"][0]
    assert act["status"] == "pending_approval" and act["target"] == {"namespace": "shopnow", "kind": "Deployment", "name": "catalog"}
    # thông báo Telegram có nút Duyệt/Từ chối với token
    msg = sent[0]
    buttons = msg["reply_markup"]["inline_keyboard"][0]
    assert [b["text"] for b in buttons] == ["✅ Duyệt", "❌ Từ chối"]
    approve_url = urlparse(buttons[0]["url"])
    token = parse_qs(approve_url.query)["token"][0]
    # token sai / token của "reject" dùng cho approve → 403
    assert c.post(f"/actions/{act['id']}/approve", params={"token": "1.abc"}).status_code == 403
    reject_tok = parse_qs(urlparse(buttons[1]["url"]).query)["token"][0]
    assert c.post(f"/actions/{act['id']}/approve", params={"token": reject_tok}).status_code == 403
    clock.t = NOW + 120
    r = c.get(approve_url.path, params={"token": token}, headers={"accept": "text/html"})
    assert r.status_code == 200 and "DRY_RUN" in r.text and backend.calls == []
    assert c.post(f"/actions/{act['id']}/approve", params={"token": token}).status_code == 409  # không duyệt lại
    inc = c.get(f"/incidents/{ids[0]}").json()
    assert inc["acknowledged_at"] == "2026-11-08T10:02:00Z" and inc["actions"][0]["status"] == "dry_run"
    # biết nguyên nhân thật → chấm RCA
    ev = c.post(f"/incidents/{ids[0]}/feedback", json={"root_cause": "catalog"}).json()
    assert ev["top1"] is True
    # alert resolved → resolved_at + MTTR
    clock.t = NOW + 600
    c.post("/webhooks/alertmanager", json={"status": "resolved", "alerts": [
        alert("catalog", status="resolved", **{}) | {"endsAt": "2026-11-08T10:09:00Z"}]})
    inc = c.get(f"/incidents/{ids[0]}").json()
    assert inc["status"] == "resolved" and inc["resolved_at"] == "2026-11-08T10:09:00Z"
    lst = c.get("/incidents").json()
    assert "items" in lst and all("detected_at" in i and "resolved_at" in i for i in lst["items"])
    m = c.get("/metrics").text
    for name in ("aiops_incidents_total", "aiops_incidents_open", "aiops_mttr_seconds_bucket", "aiops_actions_total",
                 "aiops_rca_evaluations_total", "aiops_anomaly_score", "aiops_mttd_seconds"):
        assert name in m
    assert 'aiops_actions_total{action="rollback",result="dry_run"}' in m
    assert 'aiops_rca_evaluations_total{correct="true",rank="1"}' in m


def test_dedup_and_fault_start_mttd(env):
    c, *_ = env
    a = c.post("/webhooks/alertmanager", json={"alerts": [alert("payment", fp="x1")]}).json()["incidents"][0]
    b = c.post("/webhooks/alertmanager", json={"alerts": [alert("payment", fp="x2", name="HighLatency")]}).json()["incidents"][0]
    assert a == b
    inc = c.get(f"/incidents/{a}").json()
    assert len(inc["alerts"]) == 2
    inc = c.post(f"/incidents/{a}/fault-start", json={"fault_start": "2026-11-08T09:59:00Z"}).json()
    assert inc["fault_start_source"] == "chaos"
    assert c.get(f"/incidents/{a}").json()["timings"]["mttd_s"] == 60.1


def test_real_execution_marks_mitigated(env):
    c, sent, backend, clock, s = env
    responder = c.app.state.responder
    responder.executor.dry_run = False
    inc_id = c.post("/webhooks/alertmanager", json={"alerts": [alert("catalog", fp="r1")]}).json()["incidents"][0]
    act = c.get(f"/incidents/{inc_id}").json()["actions"][0]
    tok = responder.approval_urls(act["id"])[0].split("token=")[1]
    clock.t = NOW + 300
    assert c.post(f"/actions/{act['id']}/approve", params={"token": tok}).json()["status"] == "executed"
    assert backend.calls == [("rollback", "shopnow", "Deployment", "catalog")]
    inc = c.get(f"/incidents/{inc_id}").json()
    assert inc["status"] == "mitigated" and inc["timings"]["ttm_s"] is not None


def test_reject_and_validation(env):
    c, sent, backend, *_ = env
    assert c.post("/webhooks/alertmanager", json={"nope": 1}).status_code == 400
    inc_id = c.post("/webhooks/alertmanager", json={"alerts": [alert("catalog", fp="j1")]}).json()["incidents"][0]
    act = c.get(f"/incidents/{inc_id}").json()["actions"][0]
    tok = c.app.state.responder.approval_urls(act["id"])[1].split("token=")[1]
    assert c.post(f"/actions/{act['id']}/reject", params={"token": tok}).json()["status"] == "rejected"
    assert backend.calls == []
    assert c.get("/incidents/khong-co").status_code == 404


def test_webhook_token_required(env):
    c, *_rest, s = env
    s.webhook_token = "sekret"
    assert c.post("/webhooks/alertmanager", json={"alerts": []}).status_code == 401
    assert c.post("/webhooks/alertmanager", json={"alerts": []}, headers={"authorization": "Bearer sekret"}).status_code == 200
