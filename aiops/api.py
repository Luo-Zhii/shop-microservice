"""AIOps service (FastAPI, cổng 8120).

GET  /healthz /readyz /metrics
POST /webhooks/alertmanager            nhận webhook Alertmanager (Bearer WEBHOOK_TOKEN nếu đặt)
GET  /incidents?status&service&since&limit,  GET /incidents/{id} (kèm actions + audit)
POST /incidents/{id}/ack | /resolve | /fault-start {fault_start} | /feedback {root_cause}
GET|POST /actions/{id}/approve?token=…  |  /actions/{id}/reject?token=…   (token HMAC từ thông báo)
GET  /anomalies                        snapshot điểm bất thường hiện tại
POST /rca {scores?: {svc: điểm}}       chạy RCA theo yêu cầu
POST /incidents/{id}/agent-investigate tác tử điều tra nhiều bước (LLM ReAct | planner), grounding + interlock
GET  /incidents/{id}/similar            sự cố tương tự đã đóng (dấu vân tay Jaccard có trọng số) + cách đã xử lý
GET  /incidents/{id}/postmortem?format=json|md  postmortem blameless sinh từ dữ liệu sự cố
GET  /incidents/{id}/investigations    lịch sử điều tra (bước, bằng chứng, giả thuyết, chi phí)
POST /investigations/{id}/propose-pr   bản vá shop-gitops → cổng xác minh → PR (cần người duyệt)
POST /change-risk {files:[{path,lines}], at?}  chấm rủi ro thay đổi + canary đề xuất
GET  /audit/ledger                     kiểm toán sổ cái (Benford, số tròn, ngoài giờ, trùng chi, TK nhạy cảm)
GET  /capacity/forecast?hours          dự báo rps Holt-Winters → replica đề xuất + gauge cho KEDA
GET  /slo/status                       trạng thái SLO: mục tiêu, burn rate, budget còn lại (Sloth)
GET  /platform/summary                 sự cố mở, chi phí/đơn, LCP p75, error budget (trang Tổng quan admin)
GET  /reports/alert-quality?days       chất lượng cảnh báo: flapping, tỉ lệ nhận, tỉ lệ khắc phục → khuyến nghị
GET  /reports/oncall-digest?hours  bản tin bàn giao ca trực · POST …/send đẩy lên kênh trực
POST /mcp                              MCP server (JSON-RPC 2.0) — Bearer MCP_TOKEN
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel

import httpx
import numpy as np
from . import __version__
from .agent.executor import Executor
from .agent.gitops_pr import GitHubGitOps, propose_pr
from .agent.investigator import Investigator
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
from .mcp.server import McpServer
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
    gitops = deps.pop("gitops", None)
    deps_accounting_transport = deps.pop("accounting_transport", None)
    deps_promotion_transport = deps.pop("promotion_transport", None)
    engine, responder = build(settings, **deps)
    ag = settings.section("agent")
    gcfg = ag.get("gitops") or {}
    if gitops is None:
        gitops = GitHubGitOps(os.getenv("GITOPS_REPO", gcfg.get("repo", "")), os.getenv("GITOPS_TOKEN") or None,
                              gcfg.get("base", "main"))
    icfg = ag.get("investigator") or {}
    investigator = Investigator(responder, responder.llm, int(icfg.get("max_steps", 8)),
                                price_per_mtok=float(icfg.get("price_per_mtok", 3.0)))
    mcp = McpServer(investigator.tools)
    mcp_token = os.getenv("MCP_TOKEN", "")

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
    app.state.accounting_transport = deps_accounting_transport
    app.state.promotion_transport = deps_promotion_transport
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

    # ---------------------------------------------------------------- tác tử điều tra (agentic RCA)
    @app.post("/incidents/{incident_id}/agent-investigate")
    def agent_investigate(incident_id: str, request: Request):
        if responder.store.get_incident(incident_id) is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        inv = investigator.run(incident_id)
        saved = responder.store.save_investigation(inv)
        responder.store.audit(request.headers.get("x-actor", "api"), "agent_investigated", incident_id,
                              details={"investigation": saved["id"], "mode": inv["mode"], "grounding": inv["grounding"],
                                       "action": inv["remediation"]["action"]})
        return to_api(saved)

    @app.get("/incidents/{incident_id}/investigations")
    def investigations(incident_id: str):
        return {"items": [to_api(i) for i in responder.store.investigations_for(incident_id)]}

    @app.get("/incidents/{incident_id}/similar")
    def similar(incident_id: str, k: int = Query(3, ge=1, le=10)):
        from .agent.similar import find_similar

        try:
            return {"items": find_similar(responder.store, incident_id, k)}
        except KeyError:
            return err(404, "NOT_FOUND", "không có sự cố")

    @app.get("/incidents/{incident_id}/postmortem")
    def postmortem(incident_id: str, format: str = "json"):
        from .agent.postmortem import build as build_pm

        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        pm = build_pm(inc, responder.store.actions_for(incident_id), responder.store.audit_for(incident_id),
                      responder.store.investigations_for(incident_id))
        if format == "md":
            return PlainTextResponse(pm["markdown"], media_type="text/markdown; charset=utf-8",
                                     headers={"content-disposition": f'attachment; filename="postmortem-{incident_id}.md"'})
        return pm

    @app.post("/investigations/{investigation_id}/propose-pr")
    def propose(investigation_id: str, request: Request):
        inv = responder.store.get_investigation(investigation_id)
        if inv is None:
            return err(404, "NOT_FOUND", "không có bản điều tra")
        gcfg_env = os.getenv("GITOPS_ENV", gcfg.get("env", "dev"))
        ceiling = int((ag.get("interlock") or {}).get("max_replicas", 20))
        try:
            pr = propose_pr(inv, gitops, gcfg_env, ceiling)
        except httpx.HTTPError as e:
            return err(502, "UPSTREAM_ERROR", f"GitHub lỗi: {e}")
        responder.store.update_investigation(investigation_id, pr=pr, updated_at=time.time())
        responder.store.audit(request.headers.get("x-actor", "api"), "gitops_pr_" + pr["status"], inv["incident_id"],
                              details={"investigation": investigation_id, **{k: pr.get(k) for k in ("url", "problems")}})
        return pr

    # ---------------------------------------------------------------- rủi ro thay đổi (CD gọi trước khi rollout)
    @app.post("/change-risk")
    async def change_risk(request: Request):
        from datetime import datetime

        from .change_risk import Change, score

        body = await request.json()
        files = [(str(f["path"]), int(f.get("lines", 0))) for f in (body.get("files") or [])][:5000]
        if not files:
            return err(400, "VALIDATION_ERROR", "cần danh sách files [{path, lines}]")
        when = datetime.fromisoformat(body["at"].replace("Z", "+00:00")) if body.get("at") else None
        ch = Change(files, **({"when": when} if when else {}))
        since = responder.clock() - 30 * 86400
        ch.incidents_30d = {s: len(responder.store.list_incidents(service=s, since=since, limit=50)) for s in ch.services()}
        budget = {}
        if responder.prom is not None:
            slos = (settings.raw.get("error_budget") or {}).get("slos") or {}
            try:
                remaining = {r["metric"].get("sloth_slo"): float(r["value"][1])
                             for r in responder.prom.query("slo:period_error_budget_remaining:ratio")}
            except Exception as e:  # noqa: BLE001 - Prometheus lỗi thì chấm không có chính sách budget
                log.warning("đọc error budget lỗi: %s", e)
                remaining = {}
            for slo, svcs in slos.items():
                for s in set(svcs) & set(ch.services()):
                    if slo in remaining:
                        budget[s] = min(budget.get(s, 1.0), remaining[slo])
        return {"services": ch.services(), "incidents_30d": ch.incidents_30d, **score(ch.features(), budget=budget or None)}

    # ---------------------------------------------------------------- kiểm toán sổ cái
    @app.get("/audit/ledger")
    def audit_ledger():
        from .audit.ledger import audit, fetch_entries

        url, tok = os.getenv("ACCOUNTING_URL", "http://accounting:8115"), os.getenv("INTERNAL_TOKEN", "")
        try:
            entries = fetch_entries(url, tok, transport=app.state.accounting_transport)
        except httpx.HTTPError as e:
            return err(502, "UPSTREAM_ERROR", f"accounting lỗi: {e}")
        return audit(entries)

    # ---------------------------------------------------------------- tóm tắt sức khoẻ nền tảng (trang Tổng quan admin)
    @app.get("/platform/summary")
    def platform_summary():
        out = {"incidents_open": responder.store.count_open(), "cost_per_order_usd": None, "lcp_p75_s": None,
               "error_budget": {}, "prometheus": responder.prom is not None}
        if responder.prom is None:
            return out
        queries = {"cost_per_order_usd": "shopnow:cost_per_order_usd",
                   "lcp_p75_s": 'histogram_quantile(0.75, sum by (le) (rate(web_vitals_seconds_bucket{name="LCP"}[30m])))'}
        for key, q in queries.items():
            try:
                res = responder.prom.query(q)
                v = float(res[0]["value"][1]) if res else None
                out[key] = None if v is None or v != v else round(v, 4)  # NaN → None
            except Exception as e:  # noqa: BLE001
                log.warning("platform summary %s lỗi: %s", key, e)
        try:
            out["error_budget"] = {r["metric"].get("sloth_slo"): round(float(r["value"][1]), 4)
                                   for r in responder.prom.query("slo:period_error_budget_remaining:ratio")}
        except Exception as e:  # noqa: BLE001
            log.warning("platform summary error budget lỗi: %s", e)
        return out

    # ---------------------------------------------------------------- dự báo dung lượng (predictive autoscaling)
    @app.get("/capacity/forecast")
    def capacity_forecast(hours: float = Query(1.0, gt=0, le=6)):
        from datetime import datetime, timezone

        from .capacity import apply_events, event_uplift, forecast, recommend
        from .metrics import FORECAST_RPS, FORECAST_REPLICAS

        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        cap = settings.raw.get("capacity") or {}
        step, now = int(cap.get("step_seconds", 900)), responder.clock()
        _, series = responder.prom.range_by_label(
            "sum by (service) (rate(http_server_requests_seconds_count[5m]))", now - int(cap.get("lookback_days", 8)) * 86400, now, step)
        # lịch flash sale (promotion) = biến ngoại sinh: quá khứ để học hệ số tăng tải, sắp tới để nhân vào dự báo
        start, horizon_s = now - int(cap.get("lookback_days", 8)) * 86400, int(hours * 3600)
        past, upcoming = [], []
        try:
            iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
            with httpx.Client(base_url=os.getenv("PROMOTION_URL", "http://promotion:8108"), timeout=5,
                              headers={"x-internal-token": os.getenv("INTERNAL_TOKEN", "")},
                              transport=app.state.promotion_transport) as pc:
                r = pc.get("/internal/flash-sales/window", params={"from": iso(start), "to": iso(now + horizon_s)})
                r.raise_for_status()
            for ev in r.json()["items"]:
                se = (parse_ts(ev["startsAt"]), parse_ts(ev["endsAt"]))
                (past if se[1] <= now else upcoming).append(se)
        except (httpx.HTTPError, KeyError, ValueError) as e:
            log.warning("không lấy được lịch flash sale: %s — dự báo không có biến ngoại sinh", e)
        event_services = set(cap.get("event_services") or [])
        out = []
        for svc, arr in sorted(series.items()):
            if np.count_nonzero(~np.isnan(arr)) < 24:
                continue
            fc = forecast(arr, step, horizon_s, start_ts=start)
            uplift = None
            if svc in event_services and upcoming:
                uplift = event_uplift(arr, start, step, past) or float(cap.get("default_event_uplift", 2.0))
                fc["forecast"] = apply_events(fc["forecast"], now + step, step, upcoming, uplift)
                fc["peak"] = max(fc["forecast"])
            sv = (cap.get("services") or {}).get(svc) or {}
            rpp = float(sv.get("rps_per_pod", cap.get("default_rps_per_pod", 50)))
            rep = recommend(fc["peak"], fc["rmse"], rpp, int(sv.get("min", 2)), int(sv.get("max", 10)), float(cap.get("headroom", 0.3)))
            FORECAST_RPS.labels(svc).set(fc["peak"])
            FORECAST_REPLICAS.labels(svc).set(rep)
            out.append({"service": svc, **{k: fc[k] for k in ("model", "current", "peak", "rmse")}, "rps_per_pod": rpp,
                        "recommended_min_replicas": rep, "scale_up_ahead": fc["peak"] > fc["current"] * 1.3,
                        "event_uplift": uplift})
        return {"horizon_hours": hours, "step_seconds": step, "upcoming_flash_sales": len(upcoming),
                "past_flash_sales": len(past), "items": out}

    # ---------------------------------------------------------------- trạng thái SLO (recording rule chuẩn của Sloth)
    @app.get("/slo/status")
    def slo_status():
        """Mỗi SLO: mục tiêu, tốc độ đốt budget hiện tại (1 = đốt vừa đủ hết budget đúng cuối kỳ 30 ngày), budget còn lại."""
        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        metrics = {"objective": "slo:objective:ratio", "burn_rate": "slo:current_burn_rate:ratio",
                   "period_burn_rate": "slo:period_burn_rate:ratio", "budget_remaining": "slo:period_error_budget_remaining:ratio"}
        rows: dict[str, dict] = {}
        for key, q in metrics.items():
            try:
                for r in responder.prom.query(q):
                    slo = r["metric"].get("sloth_slo")
                    if not slo:
                        continue
                    v = float(r["value"][1])
                    rows.setdefault(slo, {"slo": slo, "service": r["metric"].get("sloth_service")})[key] = None if v != v else round(v, 5)
            except Exception as e:  # noqa: BLE001
                log.warning("slo %s lỗi: %s", key, e)
        slo_svcs = ((settings.raw.get("error_budget") or {}).get("slos") or {})
        out = []
        for slo, r in sorted(rows.items()):
            rem, burn = r.get("budget_remaining"), r.get("burn_rate")
            state = ("exhausted" if rem is not None and rem <= 0 else "fast_burn" if burn is not None and burn >= 6
                     else "at_risk" if (rem is not None and rem < 0.25) or (burn is not None and burn > 1) else "healthy")
            out.append({**r, "state": state, "services": slo_svcs.get(slo, [])})
        return {"items": out}

    # ---------------------------------------------------------------- bàn giao ca trực
    @app.get("/reports/alert-quality")
    def alert_quality(days: int = Query(30, ge=1, le=180)):
        from .agent.alert_quality import analyze

        return analyze(responder.store, responder.clock(), days)

    @app.get("/reports/oncall-digest")
    def oncall_digest(hours: int = Query(24, ge=1, le=168)):
        from .agent.digest import build as build_digest

        return build_digest(responder.store, responder.clock(), hours)

    @app.post("/reports/oncall-digest/send")
    def oncall_digest_send(request: Request, hours: int = Query(24, ge=1, le=168)):
        """CronJob 8:30 sáng gọi để đẩy bản tin lên kênh trực (Telegram/Slack của Notifier)."""
        if settings.webhook_token and request.headers.get("authorization") != f"Bearer {settings.webhook_token}":
            return err(401, "UNAUTHORIZED", "thiếu hoặc sai token")
        from .agent.digest import build as build_digest

        d = build_digest(responder.store, responder.clock(), hours)
        return {"sent": responder.notifier.notify("Bàn giao ca trực", d["markdown"]), **{k: d[k] for k in ("incidents", "attention")}}

    # ---------------------------------------------------------------- MCP (Streamable HTTP, JSON)
    @app.post("/mcp")
    async def mcp_endpoint(request: Request):
        if mcp_token and request.headers.get("authorization") != f"Bearer {mcp_token}":
            return err(401, "UNAUTHORIZED", "thiếu hoặc sai MCP token")
        resp = mcp.handle_raw(await request.body())
        if resp is None:
            return PlainTextResponse("", status_code=202)
        return JSONResponse(resp, headers={"MCP-Protocol-Version": "2025-06-18"})

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
