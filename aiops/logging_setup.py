"""Log JSON (giống các service khác: time, level, service, msg, trace_id nếu có span)."""

import json
import logging
import os
import sys
import time


class JsonFormatter(logging.Formatter):
    def format(self, r: logging.LogRecord) -> str:
        out = {"time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(r.created)) + f".{int(r.msecs):03d}Z",
               "level": r.levelname.lower(), "service": "aiops", "logger": r.name, "msg": r.getMessage()}
        try:
            from opentelemetry import trace

            ctx = trace.get_current_span().get_span_context()
            if ctx and ctx.is_valid:
                out["trace_id"], out["span_id"] = format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
        except ImportError:
            pass
        if r.exc_info:
            out["err"] = self.formatException(r.exc_info)
        return json.dumps(out, ensure_ascii=False, default=str)


def setup_logging(level: str | None = None) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel((level or os.getenv("LOG_LEVEL", "info")).upper())
    for noisy in ("httpx", "urllib3", "kubernetes", "uvicorn.access", "drain3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
