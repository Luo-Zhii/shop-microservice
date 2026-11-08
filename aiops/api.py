"""AIOps service (FastAPI, cổng 8120).

GET  /healthz /readyz /metrics
POST /webhooks/alertmanager            nhận webhook Alertmanager (Bearer WEBHOOK_TOKEN nếu đặt)
GET  /incidents?status&service&since&limit,  GET /incidents/{id} (kèm actions + audit)
POST /incidents/{id}/ack | /resolve | /fault-start {fault_start} | /feedback {root_cause}
GET|POST /actions/{id}/approve?token=…  |  /actions/{id}/reject?token=…   (token HMAC từ thông báo)
GET  /anomalies                        snapshot điểm bất thường hiện tại
POST /rca {scores?: {svc: điểm}}       chạy RCA theo yêu cầu
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel

from . import __version__
from .agent.executor import Executor
from .agent.kube import KubeBackend, KubeInspector, NullInspector, RecordingBackend
from .agent.notifier import Notifier
from .agent.responder import Responder
from .agent.store import IncidentStore, to_api
from .alerting import AlertmanagerClient
from .collectors.loki import LokiClient
from .collectors.prometheus import PrometheusClient
from .collectors.service_graph import build_graph
from .config import Settings, load_settings
from .engine import DetectorEngine
from .llm.base import safe_build_provider
from .metrics import HTTP_DURATION
from .rca import rank_root_causes
from .util import parse_ts

log = logging.getLogger("aiops.api")
SERVICE = "aiops"


class FaultStartIn(BaseModel):
    fault_start: str | float
    source: str = "chaos"


class FeedbackIn(BaseModel):
    root_cause: str
    source: str = "feedback"


class RcaIn(BaseModel):
    scores: dict[str, float] | None = None


def build(settings: Settings, *, store=None, prom=None, loki=None, alerts=None, inspector=None, backend=None,
          notifier=None, llm=None, clock=time.time):
    """Lắp các thành phần (tiêm phụ thuộc được để test)."""
    store = store or IncidentStore(settings.db_url)
    if prom is None and settings.prometheus_url:
        prom = PrometheusClient(settings.prometheus_url)
    if loki is None and settings.loki_url:
        loki = LokiClient(settings.loki_url)
    if alerts is None and settings.alertmanager_url:
        alerts = AlertmanagerClient(settings.alertmanager_url)
    if inspector is None:
        inspector = KubeInspector() if settings.kube_enabled else NullInspector()
    if backend is None:
        backend = KubeBackend() if (settings.kube_enabled and not settings.dry_run) else RecordingBackend()
    allow = settings.runbook.get("allow") or {}
    executor = Executor(backend, allow.get("namespaces", [settings.namespace]),
                        allow.get("actions", ["rollback", "scale_up", "restart"]), settings.dry_run, settings.audit_log, store)
    notifier = notifier or Notifier.from_env()
    llm = llm if llm is not None else safe_build_provider(log)
    engine = DetectorEngine(settings, prom, loki, alerts, clock)
    responder = Responder(settings, store, executor, notifier, inspector, engine, prom, loki, llm, clock)
    return engine, responder


def create_app(settings: Settings | None = None, **deps) -> FastAPI:
    settings = settings or load_settings()
    engine, responder = build(settings, **deps)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        responder.refresh_open_gauge()
        if settings.detector_enabled and engine.prom is not None:
            engine.start()
            log.info("detector chạy mỗi %ss", settings.step)
        yield
        engine.stop()

    app = FastAPI(title="ShopNow AIOps", version=__version__, lifespan=lifespan)
    app.state.engine, app.state.responder = engine, responder
    _setup_tracing(app)

    @app.middleware("http")
    async def _red(request: Request, call_next):
        t0 = time.perf_counter()
        status = 500
        try:
            resp = await call_next(request)
            status = resp.status_code
            return resp
        finally:
            route = getattr(request.scope.get("route"), "path", "unknown")
            if route not in ("/metrics", "/healthz", "/readyz"):
                HTTP_DURATION.labels(SERVICE, request.method, route, str(status)).observe(time.perf_counter() - t0)

    def err(status: int, code: str, msg: str):
        return JSONResponse(status_code=status, content={"error": {"code": code, "message": msg}})

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "service": SERVICE}

    @app.get("/readyz")
    def readyz():
        checks = {"store": True}
        try:
            responder.store.list_incidents(limit=1)
        except Exception:  # noqa: BLE001
            checks["store"] = False
        snap = engine.snapshot
        checks["detector"] = (not settings.detector_enabled or engine.prom is None
                              or (snap is not None and time.time() - snap.ts < 5 * settings.step))
        ok = checks["store"]
        return JSONResponse(status_code=200 if ok else 503, content={"status": "ok" if ok else "degraded", "checks": checks})

    @app.get("/metrics")
    def metrics():
        return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    # ---------------------------------------------------------------- webhook
    @app.post("/webhooks/alertmanager")
    async def webhook(request: Request, background: BackgroundTasks):
        if settings.webhook_token:
            if request.headers.get("authorization") != f"Bearer {settings.webhook_token}":
                return err(401, "UNAUTHORIZED", "sai webhook token")
        try:
            payload = await request.json()
        except ValueError:
            return err(400, "VALIDATION_ERROR", "body không phải JSON")
        if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
            return err(400, "VALIDATION_ERROR", "thiếu alerts[]")
        ids = await _run_sync(responder.handle_webhook, payload)
        return {"incidents": ids}

    # ---------------------------------------------------------------- sự cố
    @app.get("/incidents")
    def incidents(status: str | None = None, service: str | None = None, since: str | None = None,
                  limit: int = Query(50, ge=1, le=500)):
        rows = responder.store.list_incidents(status, service, parse_ts(since) if since else None, limit)
        return {"items": [to_api(r) for r in rows], "total": len(rows)}

    @app.get("/incidents/{incident_id}")
    def incident(incident_id: str):
        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        out = to_api(inc)
        out["actions"] = [to_api(a) for a in responder.store.actions_for(incident_id)]
        out["audit"] = [to_api(a) for a in responder.store.audit_for(incident_id)]
        st = inc
        out["timings"] = {
            "mttd_s": round(st["detected_at"] - st["fault_start"], 1) if st.get("fault_start") else None,
            "tta_s": round(st["acknowledged_at"] - st["detected_at"], 1) if st.get("acknowledged_at") else None,
            "ttm_s": round(st["mitigated_at"] - (st.get("fault_start") or st["detected_at"]), 1) if st.get("mitigated_at") else None,
            "mttr_s": round(st["resolved_at"] - (st.get("fault_start") or st["detected_at"]), 1) if st.get("resolved_at") else None,
        }
        return out

    @app.post("/incidents/{incident_id}/ack")
    def ack(incident_id: str):
        try:
            return to_api(responder.acknowledge(incident_id))
        except KeyError:
            return err(404, "NOT_FOUND", "không có sự cố")

    @app.post("/incidents/{incident_id}/resolve")
    def resolve(incident_id: str):
        try:
            return to_api(responder.resolve(incident_id))
        except KeyError:
            return err(404, "NOT_FOUND", "không có sự cố")

    @app.post("/incidents/{incident_id}/fault-start")
    def fault_start(incident_id: str, body: FaultStartIn):
        ts = parse_ts(body.fault_start)
        if ts is None:
            return err(400, "VALIDATION_ERROR", "fault_start không hợp lệ")
        try:
            return to_api(responder.set_fault_start(incident_id, ts, body.source))
        except KeyError:
            return err(404, "NOT_FOUND", "không có sự cố")

    @app.post("/incidents/{incident_id}/feedback")
    def feedback(incident_id: str, body: FeedbackIn):
        """Nguyên nhân gốc thật (chaos runner hoặc kỹ sư) → chấm RCA (aiops_rca_evaluations_total{correct})."""
        try:
            return responder.evaluate_rca(incident_id, body.root_cause, body.source)
        except KeyError:
            return err(404, "NOT_FOUND", "không có sự cố")

    # ---------------------------------------------------------------- duyệt
    def _decide(action_id: str, decision: str, token: str | None, request: Request):
        try:
            a = responder.decide(action_id, decision, token, actor=request.headers.get("x-actor", "chatops"))
        except PermissionError as e:
            return err(403, "FORBIDDEN", str(e))
        except KeyError:
            return err(404, "NOT_FOUND", "không có hành động")
        except RuntimeError as e:
            return err(409, "CONFLICT", str(e))
        if "text/html" in request.headers.get("accept", ""):
            msg = {"executed": "Đã thực thi", "dry_run": "Đã duyệt (DRY_RUN — không thay đổi cluster)",
                   "rejected": "Đã từ chối", "failed": "Thực thi thất bại", "denied": "Bị chặn bởi allowlist"}
            return HTMLResponse(f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                                f"<body style='font:16px system-ui;padding:16px'><h3>{msg.get(a['status'], a['status'])}</h3>"
                                f"<p>{a['type']} {a['target'].get('kind')}/{a['target'].get('name')}</p></body>")
        return to_api(a)

    for decision in ("approve", "reject"):
        def handler(action_id: str, request: Request, token: str | None = None, _d=decision):
            return _decide(action_id, _d, token, request)

        app.add_api_route(f"/actions/{{action_id}}/{decision}", handler, methods=["GET", "POST"], name=decision)

    # ---------------------------------------------------------------- phân tích
    @app.get("/anomalies")
    def anomalies():
        snap = engine.snapshot
        return snap.to_dict() if snap else {"ts": None, "services": {}}

    @app.post("/rca")
    def rca(body: RcaIn):
        snap = engine.latest() if body.scores is None else None
        scores = body.scores or (snap.scores() if snap else {})
        graph, src = build_graph(engine.prom if body.scores is None else None, settings.raw.get("graph") or {},
                                 settings.services)
        res = rank_root_causes(graph, scores, snap.signals() if snap else None)
        return {"root_causes": res, "graph_source": src}

    return app


def _setup_tracing(app) -> None:
    import os

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:  # pragma: no cover
        log.warning("thiếu gói opentelemetry, bỏ qua tracing")
        return
    provider = TracerProvider(resource=Resource.create({"service.name": SERVICE, "service.version": __version__}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint.rstrip("/") + "/v1/traces")))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz,metrics")


async def _run_sync(fn, *args):
    import anyio

    return await anyio.to_thread.run_sync(fn, *args)
