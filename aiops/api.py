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
GET  /incidents/{id}/impact            ảnh hưởng kinh doanh ước lượng (đơn hụt, mua bù, GMV mất)
GET  /incidents/{id}/investigations    lịch sử điều tra (bước, bằng chứng, giả thuyết, chi phí)
POST /investigations/{id}/propose-pr   bản vá shop-gitops → cổng xác minh → PR (cần người duyệt)
POST /change-risk {files:[{path,lines}], at?}  chấm rủi ro thay đổi + canary đề xuất (trọng số đã học nếu có)
POST /change-risk/deploys · POST /change-risk/fit   ghi deploy thật (promote.yml) → gắn nhãn sau 2h theo RCA → học lại trọng số
GET  /audit/ledger                     kiểm toán sổ cái (Benford, số tròn, ngoài giờ, trùng chi, TK nhạy cảm)
GET  /capacity/forecast?hours          dự báo rps Holt-Winters → replica đề xuất + gauge cho KEDA
GET  /finops/rightsizing · POST /finops/rightsizing/{svc}/propose-pr  requests vs dùng thật 7 ngày → đề xuất + PR GitOps
GET  /sla/report?period · POST /sla/credits/{period}/apply  uptime tháng vs cam kết SLA người bán → hoàn phí vào sổ cái
GET  /synthetic/status                 hành trình mua hàng tổng hợp theo vị trí (on-prem/AWS), bước hỏng, p95
GET  /slo/status                       trạng thái SLO: mục tiêu, burn rate, budget còn lại (Sloth)
GET  /platform/summary                 sự cố mở, chi phí/đơn, LCP p75, error budget (trang Tổng quan admin)
GET  /reports/dora?days&environment     4 chỉ số DORA (tần suất, lead time, CFR, thời gian khôi phục) + mức elite…low
GET  /reports/alert-quality?days       chất lượng cảnh báo: flapping, tỉ lệ nhận, tỉ lệ khắc phục → khuyến nghị
GET  /reports/oncall-digest?hours  bản tin bàn giao ca trực · POST …/send đẩy lên kênh trực
POST /mcp                              MCP server (JSON-RPC 2.0) — Bearer MCP_TOKEN
"""

from __future__ import annotations

import logging
import os
import re
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
          notifier=None, llm=None, clock=time.time, profiler=None):
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
    if profiler is None and settings.pyroscope_url:
        from .collectors.pyroscope import PyroscopeClient

        profiler = PyroscopeClient(settings.pyroscope_url)
    responder.profiler = profiler          # continuous profiling (tuỳ chọn) — công cụ MCP cpu_profile
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

    dora_cache = {"at": 0.0}

    def refresh_dora() -> None:
        """Gauge DORA cho Prometheus/Grafana — tính lại tối đa 5 phút/lần (scrape 30s không phải quét DB mỗi lần)."""
        from .dora import BANDS, report
        from .metrics import DORA_BAND, DORA_VALUE

        now = responder.clock()
        if now - dora_cache["at"] < 300:
            return
        dora_cache["at"] = now
        envs = [None] + sorted({d["environment"] for d in responder.store.deploys() if d.get("environment")})
        DORA_VALUE.clear()
        DORA_BAND.clear()
        for env in envs:
            for k, m in report(responder.store, now, 30, env)["metrics"].items():
                if m["value"] is not None:
                    DORA_VALUE.labels(k, env or "all").set(m["value"])
                    DORA_BAND.labels(k, env or "all").set(BANDS.index(m["band"]))

    @app.get("/metrics")
    def metrics():
        try:
            refresh_dora()
        except Exception as e:  # noqa: BLE001 - lỗi DB không được làm hỏng scrape các metric khác
            log.warning("tính DORA cho /metrics lỗi: %s", e)
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

    def incident_impact(inc: dict) -> dict | None:
        from .agent.impact import estimate

        if responder.prom is None:
            return None
        start = inc.get("fault_start") or inc.get("detected_at")
        end = inc.get("resolved_at") or responder.clock()
        return estimate(responder.prom, float(start), float(end), responder.clock(),
                        float((settings.raw.get("business") or {}).get("default_aov_vnd", 0)))

    @app.get("/incidents/{incident_id}/impact")
    def impact(incident_id: str):
        """Ảnh hưởng kinh doanh ước lượng: đơn hụt so với hôm qua/tuần trước, trừ khách mua bù, quy ra GMV."""
        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        return {"incident_id": incident_id, "ongoing": not inc.get("resolved_at"), **incident_impact(inc)}

    def internal_terms(inc: dict) -> list[str]:
        """Từ nội bộ không được lên trang công khai: tên service (trừ 'web' — trùng "trang web"), alert, namespace."""
        terms = [x for x in settings.services if x != "web"] + [settings.namespace]
        terms += [a.get("alertname") for a in (inc.get("alerts") or []) if a.get("alertname")]
        return terms

    @app.get("/incidents/{incident_id}/status-draft")
    def status_draft(incident_id: str, phase: str = Query("investigating", pattern="^(investigating|identified|monitoring|resolved)$")):
        """Nháp thông báo công khai: mẫu tất định (an toàn by design); có LLM thì viết mượt hơn nhưng PHẢI qua bộ lọc
        rò rỉ, không qua → giữ bản mẫu. Người trực vẫn là người bấm Đăng."""
        from .statuspage import draft_update, lint_public

        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        comps = (settings.raw.get("status_page") or {}).get("components") or []
        d = {**draft_update(inc, comps, phase), "provider": "template", "llm_rejected": []}
        llm = responder.llm
        if llm is not None and getattr(llm, "available", False):
            prompt = (f"Giai đoạn: {phase}. Chức năng bị ảnh hưởng (theo cách khách gọi): {d['title']}. "
                      f"Bản nháp mẫu: {d['message']}\nViết lại tối đa 3 câu tiếng Việt, lịch sự, cho KHÁCH HÀNG đọc.")
            try:
                text = llm.chat([{"role": "user", "content": prompt}], system=(
                    "Bạn viết thông báo sự cố cho trang trạng thái công khai của sàn TMĐT. TUYỆT ĐỐI không nêu tên hệ thống nội bộ, "
                    "máy chủ, IP, mã lỗi, công cụ vận hành, nguyên nhân kỹ thuật chi tiết hay thời hạn khắc phục chưa chắc chắn. "
                    "Chỉ trả về đoạn văn, không tiêu đề."), max_tokens=300).strip()
                leaks = lint_public(text, internal_terms(inc))
                if text and not leaks and len(text) <= 600:
                    d.update(message=text, provider=llm.name)
                else:
                    d["llm_rejected"] = leaks or ["bản LLM rỗng hoặc quá dài"]
            except Exception as e:  # noqa: BLE001 - LLM lỗi thì dùng bản mẫu
                d["llm_rejected"] = [f"LLM lỗi: {str(e)[:120]}"]
        d["lint"] = lint_public(f"{d['title']}\n{d['message']}", internal_terms(inc))
        return d

    @app.post("/incidents/{incident_id}/status-updates")
    async def post_status_update(incident_id: str, request: Request):
        """Người trực đăng thông báo CÔNG KHAI cho sự cố (điều tra → xác định → theo dõi → đã khắc phục)."""
        from .statuspage import PHASES, lint_public

        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        body = await request.json()
        status, message = str(body.get("status") or ""), str(body.get("message") or "").strip()
        if status not in PHASES or not 10 <= len(message) <= 2000:
            return err(400, "VALIDATION_ERROR", f"status ∈ {list(PHASES)}, message 10–2000 ký tự")
        first = not responder.store.status_updates(incident_id)
        title = str(body.get("title") or "").strip()[:160] or None
        leaks = lint_public(f"{title or ''}\n{message}", internal_terms(inc))
        if leaks:   # không có cờ "bỏ qua": thông tin nội bộ không bao giờ được lên trang công khai
            return JSONResponse(status_code=422, content={"error": {"code": "INTERNAL_INFO_LEAK", "message":
                                "Thông báo công khai chứa thông tin nội bộ — viết lại bằng ngôn ngữ khách hàng",
                                "details": {"problems": leaks}}})
        if first and not title:
            return err(400, "VALIDATION_ERROR", "thông báo đầu tiên cần tiêu đề công khai (không dùng tên alert nội bộ)")
        impact = body.get("impact")
        if impact is not None and impact not in ("degraded_performance", "partial_outage", "major_outage"):
            return err(400, "VALIDATION_ERROR", "impact ∈ degraded_performance | partial_outage | major_outage")
        actor = request.headers.get("x-actor", "unknown")
        row = responder.store.add_status_update(incident_id, status, message, actor, responder.clock(),
                                                title if first else None, impact)
        responder.store.audit(actor, "status_update_published", incident_id, details={"status": status})
        return row

    @app.get("/incidents/{incident_id}/status-updates")
    def list_status_updates(incident_id: str):
        return {"items": responder.store.status_updates(incident_id)}

    def _period_default() -> str:
        from datetime import datetime, timedelta, timezone

        d = datetime.fromtimestamp(responder.clock(), timezone(timedelta(hours=7))).replace(day=1) - timedelta(days=1)
        return d.strftime("%Y-%m")                       # mặc định: tháng trước (đã chốt)

    @app.get("/sla/report")
    def sla_report(period: str | None = Query(None, pattern=r"^\d{4}-\d{2}$")):
        """Uptime tháng theo nhóm chức năng (cùng cách tính trang trạng thái) so với cam kết SLA với người bán."""
        from .statuspage import month_sla

        sp = settings.raw.get("status_page") or {}
        return month_sla(responder.store, sp.get("components") or [], sp.get("sla") or {}, period or _period_default(),
                         responder.clock())

    @app.post("/sla/credits/{period}/apply")
    def sla_apply(period: str, request: Request):
        """Ghi hoàn phí SLA vào sổ cái (kế toán /internal/sla-credits, idempotent). Chỉ khi tháng đã kết thúc."""
        from .statuspage import month_sla

        if not re.fullmatch(r"\d{4}-\d{2}", period):
            return err(400, "VALIDATION_ERROR", "kỳ dạng YYYY-MM")
        sp = settings.raw.get("status_page") or {}
        rep = month_sla(responder.store, sp.get("components") or [], sp.get("sla") or {}, period, responder.clock())
        if not rep["final"]:
            return err(409, "PERIOD_OPEN", "tháng chưa kết thúc — không hoàn phí trên số liệu dở dang")
        actor = request.headers.get("x-actor", "api")
        url, tok = os.getenv("ACCOUNTING_URL", "http://accounting:8115"), os.getenv("INTERNAL_TOKEN", "")
        results = []
        with httpx.Client(base_url=url, timeout=15, headers={"x-internal-token": tok},
                          transport=app.state.accounting_transport) as ac:
            for it in rep["items"]:
                if it["met"] or it["credit_pct"] <= 0:
                    continue
                r = ac.post("/internal/sla-credits", json={"period": period, "component": it["component"], "pct": it["credit_pct"],
                                                           "uptime": it["uptime"], "target": it["target"], "actor": f"aiops:{actor}"})
                if r.status_code >= 400:
                    return err(502, "UPSTREAM_ERROR", f"kế toán từ chối {it['component']}: HTTP {r.status_code} {r.text[:200]}")
                results.append({"component": it["component"], **r.json()})
        responder.store.audit(actor, "sla_credits_applied", details={"period": period,
                                                                     "total": sum(x.get("total", 0) for x in results)})
        return {"period": period, "applied": results, "report": rep}

    @app.get("/status/public")
    def public_status():
        """Trang trạng thái cho KHÁCH (gateway mở công khai đúng đường này, cache ngắn)."""
        from .statuspage import build as build_status

        comps = (settings.raw.get("status_page") or {}).get("components") or []
        failed: set[str] = set()
        if responder.prom is not None:
            try:
                failed = {r["metric"].get("service") for r in responder.prom.query("synthetic_step_success == 0")}
            except Exception as e:  # noqa: BLE001
                log.warning("status page: synthetic lỗi: %s", e)
        data = build_status(responder.store, responder.clock(), comps, failed)
        return JSONResponse(data, headers={"cache-control": "public, max-age=30"})

    @app.get("/incidents/{incident_id}/postmortem")
    def postmortem(incident_id: str, format: str = "json"):
        from .agent.postmortem import build as build_pm

        inc = responder.store.get_incident(incident_id)
        if inc is None:
            return err(404, "NOT_FOUND", "không có sự cố")
        pm = build_pm(inc, responder.store.actions_for(incident_id), responder.store.audit_for(incident_id),
                      responder.store.investigations_for(incident_id), impact=incident_impact(inc))
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

    # ---------------------------------------------------------------- FinOps: right-sizing requests
    def rightsizing_report() -> dict:
        from .rightsizing import analyze

        fin = settings.raw.get("finops") or {}
        return analyze(responder.prom, settings.namespace, fin.get("price"), float(fin.get("min_days", 3)))

    @app.get("/finops/rightsizing")
    def rightsizing():
        """requests khai báo so với mức dùng thật 7 ngày → đề xuất CPU/RAM + tiết kiệm USD/tháng (giải thích được)."""
        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        return rightsizing_report()

    @app.post("/finops/rightsizing/{service}/propose-pr")
    def rightsizing_pr(service: str, request: Request):
        """Mở PR GitOps đổi requests của MỘT service (cổng xác minh: đúng file, chỉ dòng requests, giảm ≤ 50%/lần)."""
        import difflib

        from .rightsizing import patch_requests, verify_patch

        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        item = next((x for x in rightsizing_report()["items"] if x["service"] == service), None)
        if item is None or item["direction"] == "keep":
            return err(409, "NOT_ACTIONABLE", "không có đề xuất cho service này (đủ dữ liệu và lệch ≥ 25%)")
        path = f"apps/shopnow/services/{service}.yaml"
        try:
            before, sha = gitops.read(path)
        except httpx.HTTPError as e:
            return err(502, "UPSTREAM_ERROR", f"GitHub lỗi: {e}")
        rec = item["recommended"]
        after = patch_requests(before, rec["cpu_m"], rec["mem_mi"])
        diff = "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), f"a/{path}", f"b/{path}"))
        problems = verify_patch(diff, path, service, item["current"])
        actor = request.headers.get("x-actor", "api")
        if problems:
            responder.store.audit(actor, "rightsizing_pr_rejected", details={"service": service, "problems": problems})
            return {"status": "rejected", "problems": problems, "diff": diff}
        verb = "tăng" if item["direction"] == "increase" else "giảm"
        change = {"path": path, "after": after, "diff": diff,
                  "title": f"chore({service}): AIOps right-sizing {verb} requests → cpu {rec['cpu_m']}m, mem {rec['mem_mi']}Mi"}
        body = (f"Đề xuất right-sizing từ mức dùng thật 7 ngày ({item['days_of_data']} ngày dữ liệu) — **cần người duyệt**.\n\n"
                f"| | CPU | RAM |\n|---|---|---|\n| Đang khai | {item['current']['cpu_m']}m | {item['current']['mem_mi']}Mi |\n"
                f"| Dùng thật (p95 CPU / đỉnh RAM) | {item['usage']['cpu_p95_m']}m | {item['usage']['mem_max_mi']}Mi |\n"
                f"| Đề xuất | {rec['cpu_m']}m | {rec['mem_mi']}Mi |\n\n"
                f"Tiết kiệm ước tính: **{item['monthly_saving_usd']} USD/tháng** ({item['replicas']} replica). "
                + ("Đây mới là một nấc (giảm tối đa 50%/lần) — quan sát rồi chạy lại để giảm tiếp. " if item["staged"] else "")
                + "Canary + AnalysisTemplate tự rollback nếu latency/lỗi xấu đi.")
        try:
            pr = gitops.open_pr(change, body, sha)
        except httpx.HTTPError as e:
            return err(502, "UPSTREAM_ERROR", f"GitHub lỗi: {e}")
        responder.store.audit(actor, "rightsizing_pr_opened", details={"service": service, "url": pr.get("url"),
                                                                        "saving_usd": item["monthly_saving_usd"]})
        return {"status": "proposed", "diff": diff, "title": change["title"], **pr}

    def flash_sales(start: float, end: float) -> list[tuple[float, float]]:
        """Lịch flash sale từ promotion trong [start, end] → [(bắt đầu, kết thúc)] epoch giây. Lỗi mạng ném lên cho nơi gọi."""
        from datetime import datetime, timezone

        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        with httpx.Client(base_url=os.getenv("PROMOTION_URL", "http://promotion:8108"), timeout=5,
                          headers={"x-internal-token": os.getenv("INTERNAL_TOKEN", "")},
                          transport=app.state.promotion_transport) as pc:
            r = pc.get("/internal/flash-sales/window", params={"from": iso(start), "to": iso(end)})
            r.raise_for_status()
        return [(parse_ts(ev["startsAt"]), parse_ts(ev["endsAt"])) for ev in r.json()["items"]]

    def change_freeze(at: float, services: list[str]) -> dict | None:
        """Đóng băng thay đổi quanh flash sale (như các sàn lớn dịp 11/11, Black Friday): deploy chạm service trên
        đường mua hàng trong [bắt đầu − before, kết thúc + after] → cần duyệt tay. Không đọc được lịch → không chặn
        (fail-open: mất promotion không được làm tê liệt cả quy trình release), nhưng ghi rõ trong kết quả."""
        cfg = settings.raw.get("change_freeze") or {}
        if cfg.get("enabled") is False:
            return None
        scope = set(cfg.get("services") or (settings.raw.get("capacity") or {}).get("event_services") or [])
        hit = sorted(set(services) & scope)
        if not hit:
            return None
        before, after = float(cfg.get("before_minutes", 120)) * 60, float(cfg.get("after_minutes", 60)) * 60
        try:
            sales = flash_sales(at - after, at + before)
        except (httpx.HTTPError, KeyError, ValueError) as e:
            log.warning("không đọc được lịch flash sale cho đóng băng thay đổi: %s", e)
            return {"active": False, "error": "không đọc được lịch flash sale — chưa áp đóng băng"}
        for s0, s1 in sorted(sales):
            if s0 - before <= at <= s1 + after:
                return {"active": True, "services": hit, "sale_starts": s0, "sale_ends": s1,
                        "window": [s0 - before, s1 + after]}
        return None

    @app.get("/change-risk/freeze-windows")
    def freeze_windows(hours: int = Query(48, ge=1, le=336)):
        """Lịch đóng băng thay đổi sắp tới (từ lịch flash sale) để đội phát triển lên kế hoạch release tránh giờ cao điểm."""
        from datetime import datetime, timezone

        cfg = settings.raw.get("change_freeze") or {}
        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        scope = sorted(set(cfg.get("services") or (settings.raw.get("capacity") or {}).get("event_services") or []))
        if cfg.get("enabled") is False:
            return {"enabled": False, "services": scope, "items": []}
        now = responder.clock()
        before, after = float(cfg.get("before_minutes", 120)) * 60, float(cfg.get("after_minutes", 60)) * 60
        try:
            sales = flash_sales(now - after, now + hours * 3600 + before)
        except (httpx.HTTPError, KeyError, ValueError) as e:
            return {"enabled": True, "services": scope, "items": [], "error": f"không đọc được lịch flash sale: {e}"}
        items = [{"starts": iso(s0 - before), "ends": iso(s1 + after), "sale_starts": iso(s0), "sale_ends": iso(s1),
                  "active": s0 - before <= now <= s1 + after} for s0, s1 in sorted(sales) if s1 + after >= now]
        return {"enabled": True, "services": scope, "items": items}

    # ---------------------------------------------------------------- rủi ro thay đổi (CD gọi trước khi rollout)
    @app.post("/change-risk")
    async def change_risk(request: Request):
        from datetime import datetime

        from .change_risk import ROLLOUT, Change, score

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
        model = responder.store.latest_model()
        weights = model["weights"] if model else None
        r = score(ch.features(), weights, budget=budget or None)
        fz = change_freeze(when.timestamp() if when else responder.clock(), ch.services())
        if fz and fz.get("active"):
            mins = round((fz["sale_starts"] - (when.timestamp() if when else responder.clock())) / 60)
            when_txt = f"flash sale bắt đầu sau {mins} phút" if mins > 0 else "đang trong/ngay sau flash sale"
            if body.get("emergency"):
                fz["bypassed"] = True
                r["reasons"].insert(0, f"KHẨN CẤP: bỏ qua đóng băng ({when_txt}) — bắt buộc postmortem")
                responder.store.audit(request.headers.get("x-actor", "ci"), "change_freeze_bypassed",
                                      details={"services": fz["services"], "reason": str(body.get("reason") or "")[:500]})
            else:
                r["level"], r["rollout"] = "high", {**ROLLOUT["high"], "approval": "manual"}
                r["policy"] = f"Đóng băng thay đổi: {when_txt}, chạm {', '.join(fz['services'])} — chỉ deploy khẩn cấp"
                r["reasons"].insert(0, r["policy"])
        return {"services": ch.services(), "incidents_30d": ch.incidents_30d, "weights_source": "fitted" if model else "prior",
                **r, "freeze": fz}

    @app.post("/change-risk/deploys")
    async def record_deploy(request: Request):
        """CD gọi khi một thay đổi THỰC SỰ được triển khai → lưu đặc trưng để học trọng số (nhãn gắn sau 2 giờ)."""
        from datetime import datetime

        from .change_risk import Change, score

        body = await request.json()
        files = [(str(f["path"]), int(f.get("lines", 0))) for f in (body.get("files") or [])][:5000]
        if not files:
            return err(400, "VALIDATION_ERROR", "cần danh sách files [{path, lines}]")
        at = parse_ts(body.get("at")) or responder.clock()
        ch = Change(files, when=datetime.fromtimestamp(at).astimezone())
        since = at - 30 * 86400
        ch.incidents_30d = {s: len(responder.store.list_incidents(service=s, since=since, limit=50)) for s in ch.services()}
        x = ch.features()
        lt = body.get("lead_time_s")
        rec = responder.store.add_deploy(str(body.get("ref") or ""), ch.services(), x, score(x)["probability"], at,
                                         lead_time_s=float(lt) if isinstance(lt, (int, float)) and lt >= 0 else None,
                                         environment=str(body["environment"])[:40] if body.get("environment") else None)
        return {"id": rec["id"], "services": rec["services"], "probability": rec["probability"]}

    @app.get("/change-risk/summary")
    def change_risk_summary(limit: int = Query(50, ge=1, le=500)):
        """Bảng điều khiển vòng học: change failure rate (DORA), hiệu chỉnh theo mức rủi ro (mức high có thật sự hỏng
        nhiều hơn low?), Brier score của xác suất đã dự báo, mô hình đang dùng, deploy gần nhất."""
        from datetime import datetime, timezone

        from .change_risk import PRIOR

        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        lvl = lambda p: "low" if p < 0.2 else "medium" if p < 0.5 else "high"  # noqa: E731 - cùng ngưỡng với score()
        allr = responder.store.deploys()
        lab = [d for d in allr if d["label"] is not None]
        by = {k: {"deploys": 0, "failed": 0, "predicted": 0.0} for k in ("low", "medium", "high")}
        for d in lab:
            b = by[lvl(d["probability"])]
            b["deploys"] += 1
            b["failed"] += int(d["label"])
            b["predicted"] += d["probability"]
        calib = [{"level": k, "deploys": v["deploys"], "failed": v["failed"],
                  "failure_rate": round(v["failed"] / v["deploys"], 3) if v["deploys"] else None,
                  "mean_predicted": round(v["predicted"] / v["deploys"], 3) if v["deploys"] else None} for k, v in by.items()]
        m = responder.store.latest_model()
        model = ({"source": "fitted", "records": m["n"], "positives": m["positives"], "logloss_prior": round(m["logloss_prior"], 4),
                  "logloss_fit": round(m["logloss_fit"], 4), "fitted_at": iso(m["created_at"]), "weights": m["weights"]}
                 if m else {"source": "prior", "weights": PRIOR})
        items = [{"id": d["id"], "ref": d["ref"], "services": d["services"], "probability": round(d["probability"], 3),
                  "level": lvl(d["probability"]), "label": d["label"], "deployed_at": iso(d["deployed_at"])}
                 for d in sorted(allr, key=lambda d: -d["deployed_at"])[:limit]]
        return {"deploys": len(allr), "labeled": len(lab), "pending": len(allr) - len(lab),
                "change_failure_rate": round(sum(d["label"] for d in lab) / len(lab), 3) if lab else None,
                "brier": round(sum((d["probability"] - d["label"]) ** 2 for d in lab) / len(lab), 4) if lab else None,
                "calibration": calib, "model": model, "items": items}

    @app.post("/change-risk/fit")
    def fit_risk(window_hours: float = Query(2.0, gt=0, le=48), min_records: int = Query(30, ge=5, le=10000)):
        """Gắn nhãn deploy đã quá `window_hours` (có sự cố ở service liên quan trong cửa sổ → 1) rồi học lại trọng số.
        Chỉ lưu mô hình mới nếu log-loss không tệ hơn prior trên cùng dữ liệu (chặn mô hình học hỏng)."""
        from .change_risk import FEATURES, PRIOR, fit, log_loss

        now, win = responder.clock(), window_hours * 3600
        labeled_now, by_rule = 0, {"rca": 0, "alert": 0, "rca_excluded": 0}
        for d in responder.store.deploys(unlabeled_before=now - win):
            # Làm sạch nhãn bằng RCA: sự cố chỉ "do deploy" khi nguyên nhân gốc top-1 là service vừa deploy
            # (bắt cả sự cố cảnh báo ở service hạ nguồn); chưa có RCA mới xét service bị cảnh báo.
            svcs, hit = set(d["services"]), None
            for i in responder.store.list_incidents(since=d["deployed_at"], limit=1000):
                if i["detected_at"] > d["deployed_at"] + win:
                    continue
                rc = (i.get("root_causes") or [{}])[0].get("service")
                if rc and rc in svcs or not rc and i["service"] in svcs:
                    hit = "rca" if rc else "alert"
                    break
                if rc and i["service"] in svcs:
                    by_rule["rca_excluded"] += 1   # cảnh báo ở service vừa deploy nhưng RCA chỉ ra nơi khác
            if hit:
                by_rule[hit] += 1
            responder.store.label_deploy(d["id"], int(bool(hit)), now)
            labeled_now += 1
        data = [d for d in responder.store.deploys() if d["label"] is not None]
        pos = sum(d["label"] for d in data)
        out = {"labeled_now": labeled_now, "records": len(data), "positives": pos, "label_rules": by_rule}
        if len(data) < min_records or pos == 0 or pos == len(data):
            return {**out, "fitted": False, "reason": f"cần ≥ {min_records} deploy đã gắn nhãn và có cả hai lớp"}
        X = [{k: float(d["features"].get(k, 0.0)) for k in FEATURES} for d in data]
        y = [int(d["label"]) for d in data]
        w = fit(X, y)
        ll_prior, ll_fit = log_loss(X, y, PRIOR), log_loss(X, y, w)
        if ll_fit > ll_prior:
            return {**out, "fitted": False, "reason": "mô hình mới không tốt hơn prior", "logloss_prior": round(ll_prior, 4),
                    "logloss_fit": round(ll_fit, 4)}
        responder.store.save_model(w, len(data), pos, ll_prior, ll_fit, now)
        responder.store.audit("aiops", "risk_model_fitted", details={"n": len(data), "positives": pos, "logloss": [ll_prior, ll_fit]})
        return {**out, "fitted": True, "weights": w, "logloss_prior": round(ll_prior, 4), "logloss_fit": round(ll_fit, 4)}

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
               "llm_cost_24h_usd": None, "llm_budget_remaining": None, "llm_degraded": None, "synthetic_ok": None,
               "error_budget": {}, "prometheus": responder.prom is not None}
        if responder.prom is None:
            return out
        queries = {"cost_per_order_usd": "shopnow:cost_per_order_usd",
                   "lcp_p75_s": 'histogram_quantile(0.75, sum by (le) (rate(web_vitals_seconds_bucket{name="LCP"}[30m])))',
                   # FinOps cho GenAI (ai-service llm/budget.py) + robot giám sát tổng hợp (services/synthetic)
                   "llm_cost_24h_usd": "sum(increase(ai_llm_cost_usd_total[24h]))",
                   "llm_budget_remaining": "min(ai_llm_budget_remaining_ratio)",
                   "llm_degraded": "max(ai_llm_degraded)",
                   "synthetic_ok": "min(synthetic_journey_success)"}
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
            for se in flash_sales(start, now + horizon_s):
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
        try:   # dự báo ngày cạn budget (Theil–Sen 24h) — lỗi dự báo không làm hỏng trạng thái hiện tại
            from .metrics import SLO_BUDGET_ETA
            from .slo_forecast import forecast

            fc = forecast(responder.prom, responder.clock())
            SLO_BUDGET_ETA.clear()
            for slo, f in fc.items():
                if f["eta_hours"] is not None:
                    SLO_BUDGET_ETA.labels(slo).set(f["eta_hours"])
        except Exception as e:  # noqa: BLE001
            log.warning("dự báo error budget lỗi: %s", e)
            fc = {}
        out = []
        for slo, r in sorted(rows.items()):
            rem, burn = r.get("budget_remaining"), r.get("burn_rate")
            f = fc.get(slo) or {}
            eta = f.get("eta_hours")
            state = ("exhausted" if rem is not None and rem <= 0 else "fast_burn" if burn is not None and burn >= 6
                     else "at_risk" if (rem is not None and rem < 0.25) or (burn is not None and burn > 1)
                     or (eta is not None and eta < 72) else "healthy")
            out.append({**r, "state": state, "services": slo_svcs.get(slo, []), "budget_eta_hours": eta,
                        "budget_slope_per_day": f.get("slope_per_day")})
        return {"items": out}

    @app.get("/synthetic/status")
    def synthetic_status():
        """Hành trình mua hàng tổng hợp theo từng vị trí (on-prem/AWS): bước nào hỏng, p95 từng bước, độ khả dụng 24h,
        robot có còn chạy không. Hỏng ở một vị trí mà vị trí kia vẫn ổn → nghi mạng/cụm (hybrid), không phải ứng dụng."""
        if responder.prom is None:
            return err(503, "UNAVAILABLE", "chưa cấu hình Prometheus")
        order = ["home", "search", "product", "cart_add", "cart_view", "cart_remove"]
        q = {
            "step": "synthetic_step_success",
            "p95": "histogram_quantile(0.95, sum by (le, step, location) (rate(synthetic_step_duration_seconds_bucket[30m])))",
            "journey": "synthetic_journey_success",
            "stale": "time() - synthetic_last_run_timestamp_seconds",
            "avail": ('sum by (location) (increase(synthetic_journey_runs_total{result="success"}[24h]))'
                      " / sum by (location) (increase(synthetic_journey_runs_total[24h]))"),
        }
        res: dict[str, list] = {}
        for k, expr in q.items():
            try:
                res[k] = responder.prom.query(expr)
            except Exception as e:  # noqa: BLE001 - thiếu một truy vấn vẫn trả phần còn lại
                log.warning("synthetic %s lỗi: %s", k, e)
                res[k] = []
        val = lambda r: (lambda v: None if v != v else v)(float(r["value"][1]))  # noqa: E731 - NaN → None
        locs: dict[str, dict] = {}
        loc = lambda name: locs.setdefault(name, {"location": name, "ok": None, "stale_s": None,  # noqa: E731
                                                  "availability_24h": None, "steps": {}})
        for r in res["step"]:
            m = r["metric"]
            loc(m.get("location", "?"))["steps"].setdefault(m.get("step"), {})
            loc(m.get("location", "?"))["steps"][m.get("step")].update(service=m.get("service"), ok=val(r) == 1)
        for r in res["p95"]:
            m = r["metric"]
            v = val(r)
            loc(m.get("location", "?"))["steps"].setdefault(m.get("step"), {})["p95_s"] = None if v is None else round(v, 3)
        for k, field in (("journey", "ok"), ("stale", "stale_s"), ("avail", "availability_24h")):
            for r in res[k]:
                v = val(r)
                loc(r["metric"].get("location", "?"))[field] = (v == 1) if field == "ok" else (None if v is None else round(v, 4))
        out = []
        for name, d in sorted(locs.items()):
            steps = [{"step": st, "service": d["steps"].get(st, {}).get("service"), "ok": d["steps"].get(st, {}).get("ok"),
                      "p95_s": d["steps"].get(st, {}).get("p95_s")} for st in order]
            failed = next((x["step"] for x in steps if x["ok"] is False), None)
            out.append({**d, "steps": steps, "failed_step": failed, "stale": (d["stale_s"] or 0) > 300})
        oks = [x["ok"] for x in out if x["ok"] is not None]
        diverged = len(oks) >= 2 and any(oks) and not all(oks)
        return {"locations": out, "diverged": diverged,
                "hint": "Một cụm hỏng, cụm kia vẫn ổn → kiểm tra mạng/ingress/cụm trước khi nghi ứng dụng." if diverged else None}

    # ---------------------------------------------------------------- bàn giao ca trực
    @app.get("/reports/alert-quality")
    def alert_quality(days: int = Query(30, ge=1, le=180)):
        from .agent.alert_quality import analyze

        return analyze(responder.store, responder.clock(), days)

    @app.get("/reports/dora")
    def dora_report(days: int = Query(30, ge=1, le=180), environment: str | None = Query(None, max_length=40)):
        from .dora import report

        return report(responder.store, responder.clock(), days, environment)

    @app.get("/reports/oncall-digest")
    def oncall_digest(hours: int = Query(24, ge=1, le=168)):
        from .agent.digest import build as build_digest

        return build_digest(responder.store, responder.clock(), hours, impact_fn=incident_impact)

    @app.post("/reports/oncall-digest/send")
    def oncall_digest_send(request: Request, hours: int = Query(24, ge=1, le=168)):
        """CronJob 8:30 sáng gọi để đẩy bản tin lên kênh trực (Telegram/Slack của Notifier)."""
        if settings.webhook_token and request.headers.get("authorization") != f"Bearer {settings.webhook_token}":
            return err(401, "UNAUTHORIZED", "thiếu hoặc sai token")
        from .agent.digest import build as build_digest

        d = build_digest(responder.store, responder.clock(), hours, impact_fn=incident_impact)
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
