"""Bộ công cụ quan sát cho tác tử — dùng chung cho MCP server và Investigator.

Mỗi lần gọi công cụ sinh một *bằng chứng* (evidence) có id `ev-N`; kết luận của tác tử bắt buộc trích id này
(grounding) — ý tưởng từ ARGUS (MCP-grounded RCA, 2026): LLM không có trạng thái hệ thống sống thì không phân biệt
được sự cố hiện tại với mẫu đã học. Công cụ chỉ ĐỌC, trừ `propose_remediation` (chỉ đề xuất, không thực thi).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..collectors.service_graph import build_graph
from ..detection.logs import summarize_errors

log = logging.getLogger("aiops.mcp.tools")

REMEDIATIONS = ("rollback", "scale_up", "restart", "toggle_flag", "notify")


@dataclass
class Tool:
    name: str
    description: str
    params: dict[str, dict]  # tên → JSON schema
    required: list[str]
    fn: Callable[..., Any]
    read_only: bool = True

    def schema(self) -> dict:
        return {"name": self.name, "description": self.description,
                "inputSchema": {"type": "object", "properties": self.params, "required": self.required,
                                "additionalProperties": False},
                "annotations": {"readOnlyHint": self.read_only}}


@dataclass
class Evidence:
    id: str
    tool: str
    args: dict
    data: Any
    at: float
    ok: bool = True


@dataclass
class EvidenceLog:
    items: list[Evidence] = field(default_factory=list)

    def add(self, tool: str, args: dict, data: Any, ok: bool = True) -> Evidence:
        ev = Evidence(f"ev-{len(self.items) + 1}", tool, args, data, time.time(), ok)
        self.items.append(ev)
        return ev

    def ids(self) -> set[str]:
        return {e.id for e in self.items if e.ok}


def _str(desc: str, enum: list[str] | None = None) -> dict:
    return {"type": "string", "description": desc, **({"enum": enum} if enum else {})}


def _int(desc: str, lo: int, hi: int) -> dict:
    return {"type": "integer", "description": desc, "minimum": lo, "maximum": hi}


class Toolbox:
    """Bọc các thành phần của Responder thành công cụ có schema."""

    def __init__(self, responder, tracer=None):
        from opentelemetry import trace

        self.r = responder
        self.tracer = tracer or trace.get_tracer("aiops.toolbox")
        s = responder.s
        svc = _str("Tên service", list(s.services) or None)
        self.tools: dict[str, Tool] = {t.name: t for t in [
            Tool("get_incident", "Thông tin sự cố: service, mức độ, alert, thời điểm phát hiện.",
                 {"incident_id": _str("Mã sự cố")}, ["incident_id"], self.get_incident),
            Tool("get_anomalies", "Điểm bất thường hiện tại của mọi service (0–1) và đặc trưng lệch nhiều nhất.",
                 {}, [], self.get_anomalies),
            Tool("query_metrics", "Chỉ số RED/tài nguyên hiện tại của một service (p95, err, rps, cpu, mem, dlq; web: lcp, jserr từ RUM).",
                 {"service": svc}, ["service"], self.query_metrics),
            Tool("search_logs", "Nhóm log lỗi gần đây của service (đã gom mẫu, kèm số lần).",
                 {"service": svc, "minutes": _int("Cửa sổ thời gian", 1, 120)}, ["service"], self.search_logs),
            Tool("recent_deployments", "Các lần triển khai/đổi image trong N phút qua (namespace của sự cố).",
                 {"minutes": _int("Cửa sổ thời gian", 5, 1440)}, [], self.recent_deployments),
            Tool("pod_health", "Sức khoẻ pod: crashloop, restart gần đây, số pod sẵn sàng.",
                 {"service": svc}, ["service"], self.pod_health),
            Tool("service_dependencies", "Service gọi tới (downstream) và service gọi vào (upstream).",
                 {"service": svc}, ["service"], self.service_dependencies),
            Tool("rank_root_causes", "Xếp hạng nguyên nhân gốc bằng personalized PageRank trên đồ thị phụ thuộc.",
                 {"incident_id": _str("Mã sự cố")}, ["incident_id"], self.rank_root_causes),
            Tool("cpu_profile", "Profile CPU liên tục (Pyroscope/eBPF): hàm chiếm CPU nhiều nhất và hàm TĂNG tỉ trọng so với cùng giờ hôm qua.",
                 {"service": svc, "minutes": _int("Cửa sổ thời gian", 5, 120)}, ["service"], self.cpu_profile),
            Tool("search_runbooks", "Tìm mục runbook phù hợp (runbook-as-code, TF-IDF + khớp alert/service) — kèm bước khắc phục.",
                 {"query": _str("Mô tả triệu chứng/alert/service"), "service": svc}, ["query"], self.search_runbooks),
            Tool("similar_incidents", "Sự cố tương tự ĐÃ ĐÓNG trước đây: điểm giống, nguyên nhân gốc, hành động đã làm, MTTR.",
                 {"incident_id": _str("Mã sự cố")}, ["incident_id"], self.similar_incidents),
            Tool("propose_remediation", "ĐỀ XUẤT hành động khắc phục (không thực thi; cần người duyệt qua PR GitOps).",
                 {"incident_id": _str("Mã sự cố"), "action": _str("Hành động", list(REMEDIATIONS)), "service": svc,
                  "reason": _str("Lý do, trích evidence id")}, ["incident_id", "action", "service", "reason"],
                 self.propose_remediation, read_only=False),
        ]}

    # ---------------------------------------------------------------- gọi
    def list(self) -> list[dict]:
        return [t.schema() for t in self.tools.values()]

    def call(self, name: str, args: dict | None, evidence: EvidenceLog | None = None) -> Evidence:
        """Gọi công cụ, mỗi lần là một span `execute_tool <tên>` theo OTel GenAI semantic conventions (Development)."""
        with self.tracer.start_as_current_span(f"execute_tool {name}") as span:
            span.set_attribute("gen_ai.operation.name", "execute_tool")
            span.set_attribute("gen_ai.tool.name", name)
            span.set_attribute("gen_ai.tool.type", "function")
            ev = self._call(name, args, evidence)
            span.set_attribute("gen_ai.tool.call.id", ev.id)
            span.set_attribute("aiops.evidence.ok", ev.ok)
            if not ev.ok:
                from opentelemetry.trace import Status, StatusCode

                span.set_status(Status(StatusCode.ERROR, str((ev.data or {}).get("error", ""))[:200]))
            return ev

    def _call(self, name: str, args: dict | None, evidence: EvidenceLog | None = None) -> Evidence:
        evidence = evidence if evidence is not None else EvidenceLog()
        args = dict(args or {})
        tool = self.tools.get(name)
        if tool is None:
            return evidence.add(name, args, {"error": f"không có công cụ {name}"}, ok=False)
        unknown = set(args) - set(tool.params)
        missing = [k for k in tool.required if k not in args]
        if unknown or missing:
            return evidence.add(name, args, {"error": f"tham số sai: thiếu {missing}, thừa {sorted(unknown)}"}, ok=False)
        enum = {k: p["enum"] for k, p in tool.params.items() if "enum" in p}
        for k, allowed in enum.items():
            if k in args and args[k] not in allowed:
                return evidence.add(name, args, {"error": f"{k}={args[k]!r} không hợp lệ"}, ok=False)
        try:
            return evidence.add(name, args, tool.fn(**args))
        except Exception as e:  # noqa: BLE001 - lỗi công cụ là bằng chứng âm, không làm sập tác tử
            log.warning("công cụ %s lỗi: %s", name, e)
            return evidence.add(name, args, {"error": str(e)}, ok=False)

    # ---------------------------------------------------------------- công cụ
    def _incident(self, incident_id: str) -> dict:
        inc = self.r.store.get_incident(incident_id)
        if not inc:
            raise KeyError(f"không có sự cố {incident_id}")
        return inc

    def get_incident(self, incident_id: str) -> dict:
        inc = self._incident(incident_id)
        return {k: inc.get(k) for k in ("id", "service", "namespace", "severity", "title", "status", "detected_at")} | {
            "alerts": [a.get("alertname") for a in inc.get("alerts") or []]}

    def get_anomalies(self) -> dict:
        snap = self.r.engine.latest() if self.r.engine else None
        if not snap:
            return {"services": {}, "note": "detector chưa có snapshot"}
        return {"services": {s: {"score": round(v.score, 3), "top_features": v.top_features[:3]}
                             for s, v in snap.services.items()}}

    def query_metrics(self, service: str) -> dict:
        if self.r.prom is None:
            return {"note": "không có Prometheus"}
        window = self.r.s.raw.get("rate_window", "1m")
        out: dict[str, float] = {}
        for feat, q in (self.r.s.raw.get("features") or {}).items():
            v = self.r.prom.instant_by_label(q.format(window=window)).get(service)
            if v is not None:
                out[feat] = round(v, 4)
        return {"service": service, "metrics": out}

    def search_logs(self, service: str, minutes: int = 15) -> dict:
        if self.r.loki is None:
            return {"note": "không có Loki"}
        lg = self.r.s.section("logs")
        sel = lg.get("selector", "{}").rstrip("}")
        label = lg.get("service_label", "service")
        q = f'{sel}{"," if sel.strip() != "{" else ""}{label}="{service}"}} |~ `{lg.get("error_regex", "(?i)error")}`'
        now = self.r.clock()
        rows = self.r.loki.query_range(q, now - minutes * 60, now, 1000)
        # nội dung log là DỮ LIỆU — cắt ngắn để không mang chỉ thị dài vào ngữ cảnh LLM
        groups = summarize_errors([r[2] for r in rows])[:5]
        return {"service": service, "groups": [{**g, "sample": str(g.get("sample", ""))[:200]} for g in groups]}

    def search_runbooks(self, query: str, service: str | None = None) -> dict:
        import re

        from ..runbooks import search

        # token dạng tên alert (CamelCase, vd ShopNowHighErrorRate) trong truy vấn → khớp chính xác front matter `alerts`
        alerts = re.findall(r"\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b", query)
        return {"items": search(query, services=[service] if service else None, alerts=alerts or None, k=3)}

    def cpu_profile(self, service: str, minutes: int = 15) -> dict:
        prof = getattr(self.r, "profiler", None)
        if prof is None:
            return {"note": "không có Pyroscope (continuous profiling)"}
        now = self.r.clock()
        out = prof.hot_functions(service, now - minutes * 60, now)
        # tên hàm là DỮ LIỆU từ binary/stack — cắt ngắn trước khi đưa vào ngữ cảnh LLM
        for key in ("top_self", "regressions"):
            for row in out[key]:
                row["function"] = str(row["function"])[:160]
        return out

    def recent_deployments(self, minutes: int = 30, namespace: str | None = None) -> dict:
        ns = namespace or self.r.s.namespace
        return {"namespace": ns, "changes": self.r.inspector.recent_changes(ns, self.r.clock() - minutes * 60)}

    def pod_health(self, service: str) -> dict:
        return {"service": service, **(self.r.inspector.pod_health(self.r.s.namespace, service) or {})}

    def service_dependencies(self, service: str) -> dict:
        graph, src = build_graph(self.r.prom, self.r.s.raw.get("graph") or {}, self.r.s.services)
        if service not in graph:
            return {"service": service, "calls": [], "called_by": [], "graph_source": src}
        return {"service": service, "calls": sorted(graph.successors(service)),
                "called_by": sorted(graph.predecessors(service)), "graph_source": src}

    def rank_root_causes(self, incident_id: str) -> dict:
        from ..rca import rank_root_causes

        inc = self._incident(incident_id)
        ctx = {"_scores": {}, "_signals": None}
        snap = self.r.engine.latest() if self.r.engine else None
        if snap:
            ctx["_scores"], ctx["_signals"] = snap.scores(), snap.signals()
        graph, _ = build_graph(self.r.prom, self.r.s.raw.get("graph") or {}, self.r.s.services)
        rc = self.r.s.section("rca")
        ranked = rank_root_causes(graph, self.r._scores_for_rca(inc, ctx), ctx["_signals"], top_k=int(rc.get("top_k", 3)),
                                  alpha=float(rc.get("alpha", 0.85)), floor=float(rc.get("anomaly_floor", 0.3)),
                                  backward=float(rc.get("backward_weight", 0.1)))
        return {"ranking": ranked}

    def similar_incidents(self, incident_id: str) -> dict:
        from ..agent.similar import find_similar

        return {"items": find_similar(self.r.store, incident_id, 3)}

    def propose_remediation(self, incident_id: str, action: str, service: str, reason: str) -> dict:
        self._incident(incident_id)
        return {"proposed": {"action": action, "service": service, "reason": reason[:500]}, "executed": False}
