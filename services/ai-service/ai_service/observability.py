"""Metric Prometheus (RED giống các service Node), log JSON có trace_id/span_id, OpenTelemetry OTLP HTTP."""

from __future__ import annotations

import json
import logging
import sys
import time

from opentelemetry import trace
from prometheus_client import Counter, Gauge, Histogram

HTTP_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)
HTTP_DURATION = Histogram("http_server_requests_seconds", "Thời gian xử lý HTTP (RED)",
                          ["service", "method", "route", "status"], buckets=HTTP_BUCKETS)
KAFKA_CONSUMED = Counter("kafka_messages_consumed_total", "Số message Kafka đã xử lý",
                         ["service", "topic", "type", "result"])
KAFKA_PRODUCED = Counter("kafka_messages_produced_total", "Số message Kafka đã gửi", ["service", "topic"])
MODEL_REBUILD = Histogram("ai_model_rebuild_seconds", "Thời gian dựng lại mô hình gợi ý/tìm kiếm", ["service"])
MODEL_ITEMS = Gauge("ai_model_products", "Số sản phẩm trong chỉ mục", ["service"])
LLM_CALLS = Counter("ai_llm_requests_total", "Số lần gọi LLM", ["service", "provider", "feature", "result"])

SKIP_ROUTES = {"/metrics", "/healthz", "/readyz"}


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        out = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "service": self.service,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        ctx = trace.get_current_span().get_span_context()
        if ctx and ctx.is_valid:
            out["trace_id"] = format(ctx.trace_id, "032x")
            out["span_id"] = format(ctx.span_id, "016x")
        for k, v in getattr(record, "extra_fields", {}).items():
            out[k] = v
        if record.exc_info:
            out["err"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False, default=str)


def setup_logging(service: str, level: str = "info") -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(level.upper())
    for noisy in ("aiokafka", "kafka", "httpx", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def setup_tracing(app, service: str, endpoint: str | None, version: str) -> None:
    if not endpoint:
        return
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": service, "service.version": version}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint.rstrip("/") + "/v1/traces")))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz,metrics")
    HTTPXClientInstrumentor().instrument()


def install_http_metrics(app, service: str) -> None:
    @app.middleware("http")
    async def _red(request, call_next):
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            route = request.scope.get("route")
            path = getattr(route, "path", None) or "unknown"
            if path not in SKIP_ROUTES:
                HTTP_DURATION.labels(service, request.method, path, str(status)).observe(time.perf_counter() - start)
