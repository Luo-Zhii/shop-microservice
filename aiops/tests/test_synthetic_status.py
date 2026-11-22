"""/synthetic/status: gom metric robot tổng hợp theo vị trí; bước không chạy tới = None; hỏng một cụm → diverged."""

import httpx
from fastapi.testclient import TestClient

from aiops.agent.kube import RecordingBackend, StaticInspector
from aiops.agent.notifier import Notifier
from aiops.api import create_app
from aiops.collectors.prometheus import PrometheusClient
from aiops.config import load_settings
from aiops.llm import NoneProvider

SVC = {"home": "api-gateway", "search": "search", "product": "catalog", "cart_add": "cart", "cart_view": "cart", "cart_remove": "cart"}


def _prom(req):
    q = req.url.params.get("query", "")
    v = lambda m, x: {"metric": m, "value": [0, str(x)]}  # noqa: E731
    res = []
    if q == "synthetic_step_success":
        # on-prem hỏng ở cart_add (bước sau bị bỏ nhãn); aws đi trót lọt
        for st in ("home", "search", "product", "cart_add"):
            res.append(v({"step": st, "service": SVC[st], "location": "onprem"}, 0 if st == "cart_add" else 1))
        for st in SVC:
            res.append(v({"step": st, "service": SVC[st], "location": "aws"}, 1))
    elif q.startswith("histogram_quantile"):
        res = [v({"step": "search", "location": "aws"}, 0.1234), v({"step": "home", "location": "onprem"}, "NaN")]
    elif q == "synthetic_journey_success":
        res = [v({"journey": "browse_to_cart", "location": "onprem"}, 0), v({"journey": "browse_to_cart", "location": "aws"}, 1)]
    elif q.startswith("time()"):
        res = [v({"location": "onprem"}, 42), v({"location": "aws"}, 900)]
    elif q.startswith("sum by (location)"):
        res = [v({"location": "onprem"}, 0.97), v({"location": "aws"}, 0.9993)]
    return httpx.Response(200, json={"status": "success", "data": {"resultType": "vector", "result": res}})


def test_synthetic_status_by_location(tmp_path):
    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 's.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=PrometheusClient("http://p", transport=httpx.MockTransport(_prom)), loki=None,
                     inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                     llm=NoneProvider())
    with TestClient(app) as c:
        r = c.get("/synthetic/status").json()
        by = {x["location"]: x for x in r["locations"]}
        assert r["diverged"] is True and "mạng" in r["hint"]
        on, aws = by["onprem"], by["aws"]
        assert on["ok"] is False and on["failed_step"] == "cart_add" and on["availability_24h"] == 0.97
        st = {x["step"]: x for x in on["steps"]}
        assert st["cart_add"] == {"step": "cart_add", "service": "cart", "ok": False, "p95_s": None}
        assert st["cart_view"]["ok"] is None            # không chạy tới
        assert st["home"]["p95_s"] is None              # NaN → None
        assert aws["ok"] is True and aws["failed_step"] is None and aws["stale"] is True   # robot aws im 15 phút
        assert {x["step"]: x for x in aws["steps"]}["search"]["p95_s"] == 0.123
