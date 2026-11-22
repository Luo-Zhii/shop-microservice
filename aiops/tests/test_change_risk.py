"""Chấm rủi ro thay đổi: đặc trưng từ diff, mức + canary đề xuất, fit học lại trọng số, endpoint dùng lịch sử sự cố."""

from datetime import datetime

import numpy as np

from aiops.change_risk import PRIOR, Change, fit, score

from .test_mcp_investigator import incident, make_app



def test_small_tested_change_is_low_risk():
    ch = Change([("services/review/src/routes.ts", 20), ("services/review/test/review.test.ts", 15)], when=datetime(2026, 11, 18, 3, 0).astimezone())
    x = ch.features()
    assert x["no_tests"] == 0 and x["migration"] == 0 and ch.services() == ["review"]
    r = score({**x, "after_hours": 0})
    assert r["level"] == "low" and r["rollout"]["approval"] == "auto"


def test_migration_on_payment_without_tests_at_night_is_high_risk():
    ch = Change([("services/payment/migrations/004_split.sql", 300), ("services/payment/src/repo.ts", 900),
                 ("packages/contracts/src/index.ts", 40)], when=datetime(2026, 11, 21, 23, 30).astimezone(), incidents_30d={"payment": 3})
    r = score(ch.features())
    assert r["level"] == "high" and r["rollout"]["approval"] == "manual" and r["rollout"]["steps"][0] == 5
    assert {"migration", "shared", "no_tests", "critical"} <= set(r["contributions"])
    assert r["probability"] > 0.8


def test_fit_learns_signal_from_history():
    rng = np.random.default_rng(3)
    X, y = [], []
    for _ in range(600):
        x = {"lines": rng.uniform(0, 3), "migration": float(rng.random() < 0.2), "shared": float(rng.random() < 0.1),
             "critical": float(rng.random() < 0.4), "no_tests": float(rng.random() < 0.3), "after_hours": float(rng.random() < 0.3),
             "incidents_30d": rng.uniform(0, 1)}
        # sự thật ẩn: migration rất nguy hiểm, giờ deploy không quan trọng
        z = -3 + 3.0 * x["migration"] + 0.8 * x["lines"] + 0.0 * x["after_hours"]
        X.append(x)
        y.append(int(rng.random() < 1 / (1 + np.exp(-z))))
    w = fit(X, y)
    assert w["migration"] > PRIOR["migration"] + 0.5      # học được migration nặng hơn prior
    assert abs(w["after_hours"]) < PRIOR["after_hours"]   # và giờ deploy nhẹ hơn prior


def test_endpoint_uses_incident_history(tmp_path):
    with make_app(tmp_path) as c:
        body = {"files": [{"path": "services/catalog/src/routes.ts", "lines": 120}], "at": "2026-11-18T03:00:00Z"}
        before = c.post("/change-risk", json=body).json()
        incident(c, "catalog")
        after = c.post("/change-risk", json=body).json()
        assert before["services"] == ["catalog"] and after["incidents_30d"] == {"catalog": 1}
        assert after["probability"] > before["probability"]
        assert c.post("/change-risk", json={"files": []}).status_code == 400


def test_error_budget_policy_freezes_risky_change(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    def prom(req):
        assert req.url.params["query"] == "slo:period_error_budget_remaining:ratio"
        res = [{"metric": {"sloth_slo": "checkout-latency"}, "value": [0, "-0.12"]},
               {"metric": {"sloth_slo": "web-lcp-good"}, "value": [0, "0.18"]}]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})

    s = load_settings()
    s.db_url, s.audit_log = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl")
    s.detector_enabled, s.approval_secret = False, "x"
    app = create_app(s, prom=PrometheusClient("http://prom", transport=httpx.MockTransport(prom)), loki=None,
                     inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                     llm=NoneProvider())
    with TestClient(app) as c:
        small = [{"path": "services/order/src/routes.ts", "lines": 5}, {"path": "services/order/test/order.test.ts", "lines": 5}]
        r = c.post("/change-risk", json={"files": small, "at": "2026-11-18T03:00:00Z"}).json()
        assert r["level"] == "high" and r["rollout"]["approval"] == "manual"   # thay đổi nhỏ nhưng order đã hết budget
        assert "hết error budget" in r["policy"] and r["error_budget"] == {"order": -0.12}
        web = c.post("/change-risk", json={"files": [{"path": "apps/web/src/app/page.tsx", "lines": 5}],
                                           "at": "2026-11-18T03:00:00Z"}).json()
        assert web["error_budget"] == {"web": 0.18} and web["level"] in ("medium", "high") and "18%" in web["policy"]
        review = c.post("/change-risk", json={"files": small[:1] and [{"path": "services/review/src/x.ts", "lines": 5},
                                                                       {"path": "services/review/test/x.test.ts", "lines": 5}],
                                              "at": "2026-11-18T03:00:00Z"}).json()
        assert review["policy"] is None and review["level"] == "low"


def test_error_budget_policy_overrides_level():
    x = Change([("services/review/src/a.ts", 10), ("services/review/test/a.test.ts", 5)],
               when=datetime(2026, 11, 18, 3, 0).astimezone()).features()
    x["after_hours"] = 0
    assert score(x)["level"] == "low"
    frozen = score(x, budget={"review": -0.1})
    assert frozen["level"] == "high" and frozen["rollout"]["approval"] == "manual" and "hết error budget" in frozen["policy"]
    assert score(x, budget={"review": 0.1})["level"] == "medium"
    assert score(x, budget={"review": 0.9})["policy"] is None


def test_endpoint_reads_sloth_error_budget(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    def prom(req):
        q = req.url.params.get("query", "")
        res = [{"metric": {"sloth_slo": "order-saga-success"}, "value": [0, "-0.05"]},
               {"metric": {"sloth_slo": "gateway-availability"}, "value": [0, "0.8"]}] if "error_budget_remaining" in q else []
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=PrometheusClient("http://prom", transport=httpx.MockTransport(prom)), loki=None,
                     inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                     llm=NoneProvider())
    with TestClient(app) as c:
        r = c.post("/change-risk", json={"files": [{"path": "services/order/src/saga.ts", "lines": 10},
                                                    {"path": "services/order/test/saga.test.ts", "lines": 10}],
                                         "at": "2026-11-18T03:00:00Z"}).json()
        assert r["error_budget"] == {"order": -0.05} and r["level"] == "high" and "order" in r["policy"]


def test_platform_summary(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    def prom(req):
        q = req.url.params.get("query", "")
        val = {"shopnow:cost_per_order_usd": [{"metric": {}, "value": [0, "0.0123"]}],
               "slo:period_error_budget_remaining:ratio": [{"metric": {"sloth_slo": "web-lcp-good"}, "value": [0, "0.42"]}]}
        res = val.get(q) or ([{"metric": {}, "value": [0, "NaN"]}] if "web_vitals" in q else [])
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl"), False
    deps = dict(loki=None, inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False), llm=NoneProvider())
    with TestClient(create_app(s, prom=PrometheusClient("http://p", transport=httpx.MockTransport(prom)), **deps)) as c:
        r = c.get("/platform/summary").json()
        assert r == {"incidents_open": 0, "cost_per_order_usd": 0.0123, "lcp_p75_s": None,
                     "error_budget": {"web-lcp-good": 0.42}, "prometheus": True}
    s.db_url, s.prometheus_url = f"sqlite:///{tmp_path / 'j.db'}", ""
    with TestClient(create_app(s, prom=None, **deps)) as c:
        assert c.get("/platform/summary").json()["prometheus"] is False


def test_slo_status_from_sloth_rules(tmp_path):
    import httpx
    from fastapi.testclient import TestClient

    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    vals = {"slo:objective:ratio": {"order-saga-success": 0.99, "web-lcp-good": 0.75, "gateway-availability": 0.995},
            "slo:current_burn_rate:ratio": {"order-saga-success": 0.4, "web-lcp-good": 8.0, "gateway-availability": 1.5},
            "slo:period_burn_rate:ratio": {"order-saga-success": 0.5, "web-lcp-good": 2.0, "gateway-availability": 1.1},
            "slo:period_error_budget_remaining:ratio": {"order-saga-success": 0.8, "web-lcp-good": 0.3, "gateway-availability": -0.1}}

    def prom(req):
        q = req.url.params.get("query", "")
        res = [{"metric": {"sloth_slo": k, "sloth_service": "shopnow"}, "value": [0, str(v)]} for k, v in vals.get(q, {}).items()]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=PrometheusClient("http://p", transport=httpx.MockTransport(prom)), loki=None, inspector=StaticInspector(),
                     backend=RecordingBackend(), notifier=Notifier("", "", enabled=False), llm=NoneProvider())
    with TestClient(app) as c:
        by = {i["slo"]: i for i in c.get("/slo/status").json()["items"]}
        assert by["gateway-availability"]["state"] == "exhausted"
        assert by["web-lcp-good"]["state"] == "fast_burn" and by["web-lcp-good"]["services"] == ["web", "api-gateway"]
        assert by["order-saga-success"]["state"] == "healthy" and by["order-saga-success"]["objective"] == 0.99


def test_risk_model_learns_from_deploy_history(tmp_path):
    """Vòng học: deploy có migration ở catalog thường gây sự cố trong 2h, deploy nhỏ thì không → học được trọng số
    migration lớn hơn prior; ít dữ liệu thì từ chối học; /change-risk dùng trọng số đã học."""
    from aiops.change_risk import PRIOR

    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        base = 1_790_000_000.0
        r = c.post("/change-risk/fit?min_records=30").json()
        assert r["fitted"] is False and r["records"] == 0
        empty = c.get("/change-risk/summary").json()
        assert empty["deploys"] == 0 and empty["change_failure_rate"] is None and empty["model"]["source"] == "prior"
        for k in range(40):
            at = base + k * 6 * 3600
            mig = k % 2 == 0
            files = ([{"path": "services/catalog/migrations/0%d.sql" % k, "lines": 80}] if mig else []) + \
                    [{"path": "services/catalog/src/a.ts", "lines": 30}, {"path": "services/catalog/test/a.test.ts", "lines": 20}]
            c.post("/change-risk/deploys", json={"files": files, "at": at, "ref": f"d{k}"})
            if mig and k % 4 == 0:   # một nửa deploy có migration gây sự cố trong 1 giờ
                st.create_incident(service="catalog", namespace="shopnow", severity="critical", title="x", source="test",
                                   detected_at=at + 1800, alerts=[])
        c.app.state.responder.clock = lambda: base + 41 * 6 * 3600
        r = c.post("/change-risk/fit?min_records=30").json()
        assert r["labeled_now"] == 40 and r["positives"] == 10 and r["fitted"] is True
        assert r["weights"]["migration"] > PRIOR["migration"] and r["logloss_fit"] <= r["logloss_prior"]
        scored = c.post("/change-risk", json={"files": [{"path": "services/catalog/migrations/099.sql", "lines": 80}]}).json()
        assert scored["weights_source"] == "fitted"
        sm = c.get("/change-risk/summary?limit=5").json()
        assert sm["deploys"] == 40 and sm["labeled"] == 40 and sm["pending"] == 0 and sm["change_failure_rate"] == 0.25
        assert sm["model"]["source"] == "fitted" and len(sm["items"]) == 5 and sm["items"][0]["ref"] == "d39"
        lv = {b["level"]: b for b in sm["calibration"]}
        assert sum(b["deploys"] for b in lv.values()) == 40 and 0 <= sm["brier"] <= 1
        # deploy có migration được chấm rủi ro cao hơn → nhóm mức cao hơn phải có tỉ lệ hỏng ≥ nhóm thấp
        rates = [lv[k]["failure_rate"] for k in ("low", "medium", "high") if lv[k]["deploys"]]
        assert rates == sorted(rates)
        c.post("/change-risk/deploys", json={"files": [{"path": "services/order/src/x.ts", "lines": 5}], "at": base + 40 * 6 * 3600,
                                             "lead_time_s": 5400, "environment": "staging"})
        dora = c.get("/reports/dora?days=30&environment=staging").json()
        assert dora["counts"]["deploys"] == 1 and dora["metrics"]["lead_time"]["value"] == 5400
        assert dora["metrics"]["lead_time"]["band"] == "elite" and dora["overall"] is None
        c.app.state.responder.clock = lambda: base + 41 * 6 * 3600 + 3600   # quá cache 5 phút
        text = c.get("/metrics").text
        assert 'aiops_dora_value{environment="staging",metric="lead_time"} 5400.0' in text
        assert 'aiops_dora_band{environment="staging",metric="lead_time"} 0.0' in text and 'environment="all"' in text


def test_fit_labels_use_rca_root_cause(tmp_path):
    """Nhãn sạch: sự cố cảnh báo ở catalog nhưng RCA chỉ ra payment → deploy catalog KHÔNG bị gắn nhãn gây sự cố;
    sự cố cảnh báo ở order nhưng RCA = inventory → deploy inventory bị gắn nhãn (bắt được lỗi lan hạ nguồn)."""
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        base = 1_790_000_000.0
        cases = [("catalog", "catalog", "payment", 0), ("inventory", "order", "inventory", 1),
                 ("search", "search", None, 1), ("review", "order", None, 0)]
        for k, (dep, alerted, root, _) in enumerate(cases):
            at = base + k * 6 * 3600
            c.post("/change-risk/deploys", json={"files": [{"path": f"services/{dep}/src/a.ts", "lines": 10}], "at": at, "ref": dep})
            inc = st.create_incident(service=alerted, namespace="shopnow", severity="critical", title="x", source="test",
                                     detected_at=at + 600, alerts=[])
            if root:
                st.update_incident(inc["id"], root_causes=[{"service": root, "score": 0.9}])
        c.app.state.responder.clock = lambda: base + 30 * 3600
        r = c.post("/change-risk/fit?min_records=30").json()
        assert r["labeled_now"] == 4 and r["positives"] == 2
        assert r["label_rules"] == {"rca": 1, "alert": 1, "rca_excluded": 1}
        labels = {d["ref"]: d["label"] for d in st.deploys()}
        assert labels == {dep: want for dep, _, _, want in cases}
