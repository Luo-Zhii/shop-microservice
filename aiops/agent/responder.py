"""Tác tử xử lý sự cố.

Alertmanager webhook → tạo/gộp sự cố (khử trùng theo service trong `dedup_minutes`) → gom bối cảnh
(snapshot điểm bất thường + metric hiện tại, top log lỗi Loki, triển khai trong 30 phút qua, sức khoẻ pod)
→ RCA (personalized PageRank) → chọn hành động từ runbook → tóm tắt (LLM | template) → thông báo kèm nút
Duyệt/Từ chối có token HMAC → thực thi qua Executor (allowlist + DRY_RUN) → ghi mốc thời gian:
fault_start (biết trước từ chaos runner, hoặc ước lượng từ thời điểm điểm bất thường bắt đầu tăng),
detected_at (startsAt của alert), acknowledged_at (lần bấm duyệt/từ chối đầu), mitigated_at (thực thi thành công),
resolved_at (alert resolved). MTTD = detected_at − fault_start; MTTR = resolved_at − fault_start (hoặc detected_at).
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import time

from ..collectors.service_graph import build_graph
from ..detection.logs import summarize_errors
from ..metrics import ACTIONS, INCIDENTS, INCIDENTS_OPEN, MTTD, MTTR, RCA_EVALUATIONS
from ..rca import rank_root_causes
from ..util import iso, parse_ts
from . import approval
from .runbook import choose_action
from .summarizer import summarize

log = logging.getLogger("aiops.responder")

ALERT_SYMPTOMS = {"latency": "p95", "slow": "p95", "error": "err", "5xx": "err", "cpu": "cpu", "throttl": "cpu",
                  "memory": "mem", "oom": "mem", "dlq": "dlq", "crash": "err", "down": "rps"}


def alert_service(labels: dict) -> str | None:
    for k in ("service", "app", "app_kubernetes_io_name", "deployment", "rollout", "container", "job"):
        if labels.get(k):
            return labels[k]
    return None


def fingerprint(alert: dict) -> str:
    if alert.get("fingerprint"):
        return str(alert["fingerprint"])
    labels = alert.get("labels") or {}
    return hashlib.sha256(json.dumps(labels, sort_keys=True).encode()).hexdigest()[:16]


class Responder:
    def __init__(self, settings, store, executor, notifier, inspector, engine=None, prom=None, loki=None, llm=None,
                 clock=time.time):
        self.s, self.store, self.executor, self.notifier = settings, store, executor, notifier
        self.inspector, self.engine, self.prom, self.loki, self.llm, self.clock = inspector, engine, prom, loki, llm, clock
        self.secret = settings.approval_secret or secrets.token_hex(32)
        if not settings.approval_secret:
            log.warning("APPROVAL_SECRET chưa đặt — dùng khoá ngẫu nhiên (token mất hiệu lực khi khởi động lại)")
        ag = settings.section("agent")
        self.dedup_s = int(ag.get("dedup_minutes", 30)) * 60
        self.lookback_s = int(ag.get("deploy_lookback_minutes", 30)) * 60
        self.ttl_s = int(ag.get("approval_ttl_minutes", 120)) * 60

    # ================================================================ webhook
    def handle_webhook(self, payload: dict) -> list[str]:
        touched: list[str] = []
        for alert in payload.get("alerts") or []:
            labels = alert.get("labels") or {}
            svc = alert_service(labels)
            if not svc:
                log.warning("bỏ qua alert không có nhãn service: %s", labels)
                continue
            fp = fingerprint(alert)
            status = alert.get("status") or payload.get("status") or "firing"
            if status == "resolved":
                inc = self.store.find_by_fingerprint(fp)
                if inc:
                    self._resolve_alert(inc, fp, parse_ts(alert.get("endsAt")) or self.clock())
                    touched.append(inc["id"])
                continue
            entry = {"fingerprint": fp, "status": "firing", "alertname": labels.get("alertname"), "labels": labels,
                     "annotations": alert.get("annotations") or {}, "startsAt": alert.get("startsAt")}
            detected = parse_ts(alert.get("startsAt")) or self.clock()
            inc = self.store.find_open(svc, self.clock() - self.dedup_s)
            if inc:
                alerts = inc.get("alerts") or []
                if all(a["fingerprint"] != fp for a in alerts):
                    alerts.append(entry)
                    self.store.update_incident(inc["id"], alerts=alerts)
                    self.store.audit("alertmanager", "alert_merged", inc["id"], details={"fingerprint": fp})
                touched.append(inc["id"])
                continue
            fault_start = parse_ts((alert.get("annotations") or {}).get("fault_start"))
            inc = self.store.create_incident(
                service=svc, namespace=labels.get("namespace") or self.s.namespace,
                severity=labels.get("severity", "warning"), title=(alert.get("annotations") or {}).get("summary")
                or f"{labels.get('alertname', 'Alert')} — {svc}", source=labels.get("source", "prometheus"),
                detected_at=detected, fault_start=fault_start, fault_start_source="annotation" if fault_start else None,
                alerts=[entry])
            self.refresh_open_gauge()
            self.store.audit("alertmanager", "incident_created", inc["id"], details={"alert": labels})
            touched.append(inc["id"])
            try:
                self.investigate(inc["id"])
            except Exception as e:  # noqa: BLE001 - không để webhook lỗi vì bước điều tra
                log.exception("điều tra sự cố %s lỗi: %s", inc["id"], e)
                self.store.audit("agent", "investigate_failed", inc["id"], details={"error": str(e)})
        return touched

    # ================================================================ điều tra
    def gather(self, inc: dict) -> dict:
        svc, ns = inc["service"], inc["namespace"]
        ctx: dict = {"anomaly": {}, "metrics": {}, "log_errors": [], "deploys": [], "pods": {}}
        snap = self.engine.latest() if self.engine else None
        if snap:
            ctx["anomaly"] = {s: {"score": round(v.score, 3), "top_features": v.top_features, "onset": v.onset}
                              for s, v in snap.services.items() if v.score >= 0.2 or s == svc}
            ctx["_scores"], ctx["_signals"] = snap.scores(), snap.signals()
        if self.prom is not None:
            window = self.s.raw.get("rate_window", "1m")
            for feat, q in (self.s.raw.get("features") or {}).items():
                try:
                    for k, v in self.prom.instant_by_label(q.format(window=window)).items():
                        ctx["metrics"].setdefault(k, {})[feat] = round(v, 4)
                except Exception as e:  # noqa: BLE001
                    log.debug("metric %s lỗi: %s", feat, e)
        if self.loki is not None:
            lg = self.s.section("logs")
            sel = lg.get("selector", "{}").rstrip("}")
            label = lg.get("service_label", "service")
            q = f'{sel}{"," if sel.strip() != "{" else ""}{label}="{svc}"}} |~ `{lg.get("error_regex", "(?i)error")}`'
            try:
                rows = self.loki.query_range(q, self.clock() - 900, self.clock(), 1000)
                ctx["log_errors"] = summarize_errors([r[2] for r in rows])
            except Exception as e:  # noqa: BLE001
                log.warning("lấy log Loki lỗi: %s", e)
        try:
            ctx["deploys"] = self.inspector.recent_changes(ns, self.clock() - self.lookback_s)
        except Exception as e:  # noqa: BLE001
            log.warning("đọc triển khai gần đây lỗi: %s", e)
        return ctx

    def _scores_for_rca(self, inc: dict, ctx: dict) -> dict[str, float]:
        scores = dict(ctx.get("_scores") or {})
        # alert của chính sự cố (vd từ PrometheusRule) cũng là bằng chứng bất thường
        for a in inc.get("alerts") or []:
            s = alert_service(a.get("labels") or {})
            if s:
                scores[s] = max(scores.get(s, 0.0), 0.7)
        # các sự cố khác đang mở cùng lúc
        for other in self.store.list_incidents(status="open", since=self.clock() - 900, limit=50):
            scores[other["service"]] = max(scores.get(other["service"], 0.0), 0.6)
        return scores

    def investigate(self, incident_id: str) -> dict:
        inc = self.store.get_incident(incident_id)
        ctx = self.gather(inc)
        graph, graph_src = build_graph(self.prom, self.s.raw.get("graph") or {}, self.s.services)
        rcfg = self.s.section("rca")
        rca = rank_root_causes(graph, self._scores_for_rca(inc, ctx), ctx.get("_signals"), top_k=int(rcfg.get("top_k", 3)),
                               alpha=float(rcfg.get("alpha", 0.85)), floor=float(rcfg.get("anomaly_floor", 0.3)),
                               backward=float(rcfg.get("backward_weight", 0.1)))
        target = rca[0]["service"] if rca else inc["service"]
        ns = inc["namespace"]
        dep = next((d for d in ctx["deploys"] if d["name"] == target), None)
        try:
            pods = self.inspector.pod_health(ns, target) or {}
        except Exception as e:  # noqa: BLE001
            log.warning("đọc pod lỗi: %s", e)
            pods = {}
        ctx["target_deploy"], ctx["target_pods"] = dep, pods
        symptoms = {f for f, z in ((ctx.get("anomaly") or {}).get(target) or {}).get("top_features", []) if z >= 3}
        for a in inc.get("alerts") or []:
            name = (a.get("alertname") or "").lower()
            symptoms |= {f for k, f in ALERT_SYMPTOMS.items() if k in name}
        decision = choose_action(self.s.runbook, {"service": target, "recent_deploy": dep is not None,
                                                 "crashloop": bool(pods.get("crashloop")),
                                                 "pod_restarted": bool(pods.get("pod_restarted")),
                                                 "symptoms": sorted(symptoms), "score": (ctx.get("_scores") or {}).get(target, 0)})
        decision["target"] = target
        summary, provider = summarize(inc, ctx, rca, decision, self.llm)
        # thời điểm lỗi bắt đầu: ưu tiên giá trị biết trước, không thì ước lượng từ onset của detector
        updates: dict = {"root_causes": rca, "decision": decision, "summary": summary,
                         "context": {k: v for k, v in ctx.items() if not k.startswith("_")} | {"graph_source": graph_src,
                                                                                               "summary_provider": provider}}
        if inc.get("fault_start") is None:
            onset = ((ctx.get("anomaly") or {}).get(inc["service"]) or {}).get("onset")
            if onset and onset <= inc["detected_at"]:
                updates.update(fault_start=onset, fault_start_source="estimated")
        inc = self.store.update_incident(incident_id, **updates)
        INCIDENTS.labels(inc.get("severity") or "warning", target).inc()
        if inc.get("fault_start") is not None:
            MTTD.labels(inc["source"], inc.get("fault_start_source") or "unknown").observe(
                max(0.0, inc["detected_at"] - inc["fault_start"]))
        self.store.audit("agent", "investigated", incident_id, details={"root_cause": target, "decision": decision})
        action = None
        if decision["action"] != "notify":
            workload = self.inspector.workload(ns, target) or {"kind": "Deployment", "name": target}
            action = self.store.create_action(incident_id=incident_id, type=decision["action"],
                                              target={"namespace": ns, **workload}, params=decision["params"],
                                              status="pending_approval" if decision["approval"] == "required" else "approved",
                                              approval=decision["approval"], rule=decision["rule"], reason=decision["reason"])
        self._notify(inc, action)
        if action and action["status"] == "approved":
            self.execute(action["id"], actor="auto")
        return self.store.get_incident(incident_id)

    def approval_urls(self, action_id: str) -> tuple[str, str]:
        base = self.s.public_url.rstrip("/")
        return (f"{base}/actions/{action_id}/approve?token={approval.sign(self.secret, action_id, 'approve', self.ttl_s)}",
                f"{base}/actions/{action_id}/reject?token={approval.sign(self.secret, action_id, 'reject', self.ttl_s)}")

    def _notify(self, inc: dict, action: dict | None) -> None:
        base = self.s.public_url.rstrip("/")
        title = f"[{inc['severity'].upper()}] Sự cố {inc['service']} — {inc['id'][:8]}"
        body = inc.get("summary") or ""
        approve = reject = None
        if action and action["status"] == "pending_approval":
            approve, reject = self.approval_urls(action["id"])
            body += f"\n\nHành động chờ duyệt: {action['type']} {action['target']['kind']}/{action['target']['name']}" \
                    f"{' (DRY_RUN)' if self.executor.dry_run else ''}"
        res = self.notifier.notify(title, body, approve, reject, f"{base}/incidents/{inc['id']}")
        self.store.audit("agent", "notified", inc["id"], action["id"] if action else None, {"channels": res})

    # ================================================================ duyệt + thực thi
    def decide(self, action_id: str, decision: str, token: str | None, actor: str = "chatops") -> dict:
        if decision not in ("approve", "reject"):
            raise ValueError("decision phải là approve|reject")
        if not approval.verify(self.secret, action_id, decision, token):
            raise PermissionError("token không hợp lệ hoặc đã hết hạn")
        action = self.store.get_action(action_id)
        if action is None:
            raise KeyError(action_id)
        if action["status"] != "pending_approval":
            raise RuntimeError(f"hành động đã ở trạng thái {action['status']}")
        now = self.clock()
        inc = self.store.get_incident(action["incident_id"])
        if inc and inc.get("acknowledged_at") is None:
            self.store.update_incident(inc["id"], acknowledged_at=now,
                                       status="acknowledged" if inc["status"] == "open" else inc["status"])
        self.store.update_action(action_id, status="approved" if decision == "approve" else "rejected",
                                 decided_at=now, decided_by=actor)
        self.store.audit(actor, f"action_{decision}d", action["incident_id"], action_id)
        if decision == "reject":
            ACTIONS.labels(action["type"], "rejected").inc()
            return self.store.get_action(action_id)
        return self.execute(action_id, actor)

    def execute(self, action_id: str, actor: str) -> dict:
        action = self.store.get_action(action_id)
        res = self.executor.execute(action)
        now = self.clock()
        status = {"executed": "executed", "dry_run": "dry_run", "denied": "denied"}.get(res["result"], "failed")
        self.store.update_action(action_id, status=status, result=res, executed_at=now)
        ACTIONS.labels(action["type"], res["result"]).inc()
        if res["result"] == "executed":
            inc = self.store.get_incident(action["incident_id"])
            if inc and inc.get("mitigated_at") is None:
                self.store.update_incident(inc["id"], mitigated_at=now,
                                           status="mitigated" if inc["status"] in ("open", "acknowledged") else inc["status"])
        return self.store.get_action(action_id)

    # ================================================================ kết thúc
    def _resolve_alert(self, inc: dict, fp: str, at: float) -> None:
        alerts = inc.get("alerts") or []
        for a in alerts:
            if a["fingerprint"] == fp:
                a["status"] = "resolved"
        self.store.update_incident(inc["id"], alerts=alerts)
        if all(a.get("status") == "resolved" for a in alerts):
            self.resolve(inc["id"], at, actor="alertmanager")

    def resolve(self, incident_id: str, at: float | None = None, actor: str = "api") -> dict:
        inc = self.store.get_incident(incident_id)
        if inc is None:
            raise KeyError(incident_id)
        if inc["status"] == "resolved":
            return inc
        at = at or self.clock()
        inc = self.store.update_incident(incident_id, status="resolved", resolved_at=at)
        self.refresh_open_gauge()
        start = inc.get("fault_start") or inc["detected_at"]
        basis = inc.get("fault_start_source") or "detected"
        MTTR.labels(inc["source"], basis if inc.get("fault_start") else "detected").observe(max(0.0, at - start))
        self.store.audit(actor, "incident_resolved", incident_id, details={"resolved_at": iso(at)})
        return inc

    def refresh_open_gauge(self) -> None:
        try:
            INCIDENTS_OPEN.set(self.store.count_open())
        except Exception as e:  # noqa: BLE001
            log.debug("không đếm được sự cố mở: %s", e)

    def evaluate_rca(self, incident_id: str, true_root: str, source: str = "chaos") -> dict:
        """Biết nguyên nhân thật (chaos runner / kỹ sư phản hồi) → chấm RCA, tăng aiops_rca_evaluations_total."""
        inc = self.store.get_incident(incident_id)
        if inc is None:
            raise KeyError(incident_id)
        ranked = [r["service"] for r in inc.get("root_causes") or []]
        rank = ranked.index(true_root) + 1 if true_root in ranked else 0
        RCA_EVALUATIONS.labels("true" if rank == 1 else "false", str(rank) if rank else "miss").inc()
        ev = {"true_root_cause": true_root, "rank": rank or None, "top1": rank == 1, "top3": 0 < rank <= 3,
              "source": source}
        ctx = dict(inc.get("context") or {})
        ctx["rca_evaluation"] = ev
        self.store.update_incident(incident_id, context=ctx)
        self.store.audit(source, "rca_evaluated", incident_id, details=ev)
        return ev

    def set_fault_start(self, incident_id: str, ts: float, source: str = "chaos") -> dict:
        inc = self.store.get_incident(incident_id)
        if inc is None:
            raise KeyError(incident_id)
        inc = self.store.update_incident(incident_id, fault_start=ts, fault_start_source=source)
        MTTD.labels(inc["source"], source).observe(max(0.0, inc["detected_at"] - ts))
        self.store.audit("api", "fault_start_set", incident_id, details={"fault_start": iso(ts), "source": source})
        return inc

    def acknowledge(self, incident_id: str, actor: str = "api") -> dict:
        inc = self.store.get_incident(incident_id)
        if inc is None:
            raise KeyError(incident_id)
        if inc.get("acknowledged_at") is None:
            inc = self.store.update_incident(incident_id, acknowledged_at=self.clock(),
                                             status="acknowledged" if inc["status"] == "open" else inc["status"])
            self.store.audit(actor, "incident_acknowledged", incident_id)
        return inc
