"""FastAPI app ai-service (cổng 8114). Hợp đồng: docs/architecture.md §5.

Phản hồi gợi ý/tìm kiếm: `{items: [thẻ SP], strategy|mode, ...}`, thẻ SP =
`{id, productId, shopId, shopName, categoryId, title, slug, image, minPrice, maxPrice, ratingAvg, ratingCount,
soldCount, score, reason: co_purchase|similar|popular|match}`.
`/chat` → `{reply, sources: [{type: faq|product, id, title, score}], products, provider, intent}`.
`/generate/description` → `{description, highlights, provider}`; `/moderate` → `{allowed, labels, score, evidence, provider}`.
Chạy: `KAFKA_ENABLED=false python -m ai_service` (DATABASE_URL=memory:// để chạy không cần Postgres).
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, Field

from . import __version__
from .chat import answer
from .config import Settings
from .consumer import EventConsumer
from .engine import CatalogIndex, FaqIndex, load_faq
from .generator import generate
from .llm.base import LLMError, safe_build_provider
from .moderation import moderate
from .observability import (LLM_CALLS, MODEL_ITEMS, MODEL_REBUILD, install_http_metrics, setup_logging,
                            setup_tracing)
from .store import make_store

log = logging.getLogger("ai_service")


class ChatTurn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=50)


class DescribeIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    attributes: dict[str, str] = Field(default_factory=dict)
    category: str | None = None
    brand: str | None = None
    keywords: list[str] = Field(default_factory=list)


class ModerateIn(BaseModel):
    text: str = Field(max_length=20000)


class AiState:
    def __init__(self, settings: Settings, store=None, llm=None):
        self.settings = settings
        self.store = store or make_store(settings.database_url)
        self.llm = llm if llm is not None else safe_build_provider(log, name=settings.llm_provider)
        self.faq = FaqIndex.build(load_faq(settings.faq_path))
        self.catalog = CatalogIndex()
        self.version: Any = None
        self.dirty = True
        self._lock = threading.Lock()
        self.consumer: EventConsumer | None = None

    def mark_dirty(self) -> None:
        self.dirty = True

    def _embedder(self):
        if not (self.settings.embeddings_enabled and self.llm.available):
            return None
        return self.llm.embed

    def rebuild(self, force: bool = False) -> bool:
        with self._lock:
            version = self.store.version()
            if not force and not self.dirty and version == self.version:
                return False
            t0 = time.perf_counter()
            self.dirty = False
            self.catalog = CatalogIndex.build(self.store.all_products(), self.store.all_purchases(), self._embedder())
            self.version = version
            MODEL_REBUILD.labels(self.settings.service_name).observe(time.perf_counter() - t0)
            MODEL_ITEMS.labels(self.settings.service_name).set(len(self.catalog))
            return True

    def query_embedding(self, q: str):
        if self.catalog.emb is None:
            return None
        try:
            return self.llm.embed([q])[0]
        except LLMError as e:
            log.warning("embedding truy vấn lỗi: %s", e)
            return None


def create_app(settings: Settings | None = None, store=None, llm=None) -> FastAPI:
    settings = settings or Settings()
    setup_logging(settings.service_name, settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st: AiState = app.state.ai
        await asyncio.to_thread(st.store.migrate)
        await asyncio.to_thread(st.rebuild, True)

        async def loop():
            while True:
                await asyncio.sleep(settings.rebuild_interval_s)
                try:
                    await asyncio.to_thread(st.rebuild)
                except Exception as e:  # noqa: BLE001
                    log.warning("dựng lại mô hình lỗi: %s", e)

        task = asyncio.create_task(loop())
        if settings.kafka_enabled:
            st.consumer = EventConsumer(st.store, settings.kafka_brokers, settings.kafka_group,
                                        settings.service_name, st.mark_dirty)
            await st.consumer.start()
        log.info("ai-service sẵn sàng: provider=%s kafka=%s", st.llm.name, settings.kafka_enabled)
        try:
            yield
        finally:
            task.cancel()
            if st.consumer:
                await st.consumer.stop()
            st.store.close()

    app = FastAPI(title="ShopNow ai-service", version=__version__, lifespan=lifespan)
    app.state.ai = AiState(settings, store, llm)
    install_http_metrics(app, settings.service_name)
    setup_tracing(app, settings.service_name, settings.otel_endpoint, __version__)
    svc = settings.service_name

    def err(status: int, code: str, message: str, details: Any = None):
        body: dict = {"error": {"code": code, "message": message}}
        if details is not None:
            body["error"]["details"] = details
        return JSONResponse(status_code=status, content=body)

    @app.exception_handler(RequestValidationError)
    async def _validation(_req: Request, exc: RequestValidationError):
        return err(400, "VALIDATION_ERROR", "Dữ liệu không hợp lệ", jsonable(exc.errors()))

    @app.exception_handler(HTTPException)
    async def _http(_req: Request, exc: HTTPException):
        code = {404: "NOT_FOUND", 400: "VALIDATION_ERROR", 401: "UNAUTHORIZED", 403: "FORBIDDEN"}.get(exc.status_code, "INTERNAL")
        return err(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception):
        log.exception("lỗi không xử lý: %s", exc)
        return err(500, "INTERNAL", "Lỗi máy chủ")

    def state() -> AiState:
        return app.state.ai

    # ---------------- vận hành ----------------
    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "service": svc}

    @app.get("/readyz")
    def readyz():
        st = state()
        checks = {"db": st.store.ping(), "kafka": (not settings.kafka_enabled) or bool(st.consumer and st.consumer.connected),
                  "model": st.catalog.built_at > 0}
        ok = all(checks.values())
        return JSONResponse(status_code=200 if ok else 503, content={"status": "ok" if ok else "degraded", "checks": checks})

    @app.get("/metrics")
    def metrics():
        return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    # ---------------- gợi ý ----------------
    @app.get("/recommendations/user/{user_id}")
    def rec_user(user_id: str, limit: int = Query(10, ge=1, le=50)):
        items, strategy = state().catalog.for_user(user_id, limit)
        return {"items": items, "strategy": strategy, "userId": user_id}

    @app.get("/recommendations/product/{product_id}")
    def rec_product(product_id: str, limit: int = Query(10, ge=1, le=50)):
        items, strategy = state().catalog.for_product(product_id, limit)
        return {"items": items, "strategy": strategy, "productId": product_id}

    @app.get("/search/semantic")
    def semantic(q: str = Query(..., min_length=1, max_length=200), limit: int = Query(20, ge=1, le=100)):
        st = state()
        items, mode = st.catalog.search(q, limit, st.query_embedding(q))
        return {"items": items, "total": len(items), "mode": mode, "q": q}

    # ---------------- chatbot / sinh nội dung / kiểm duyệt ----------------
    @app.post("/chat")
    def chat(body: ChatIn):
        st = state()
        res = answer(body.message, [t.model_dump() for t in body.history], st.faq, st.catalog, st.llm)
        LLM_CALLS.labels(svc, st.llm.name, "chat", "ok" if res["provider"] == st.llm.name else "fallback").inc()
        return res

    @app.post("/generate/description")
    def describe(body: DescribeIn):
        st = state()
        res = generate(body.title, body.attributes, body.category, body.brand, body.keywords, st.llm)
        LLM_CALLS.labels(svc, st.llm.name, "description", "ok" if res["provider"] == st.llm.name else "fallback").inc()
        return res

    @app.post("/moderate")
    def moderate_ep(body: ModerateIn):
        return moderate(body.text, state().llm)

    @app.post("/internal/rebuild")
    def rebuild_ep(request: Request):
        token = os.getenv("INTERNAL_TOKEN")
        if token and request.headers.get("x-internal-token") != token:
            raise HTTPException(401, "Thiếu hoặc sai x-internal-token")
        return {"rebuilt": state().rebuild(force=True), "products": len(state().catalog)}

    return app


def jsonable(errors):
    out = []
    for e in errors:
        out.append({k: (v if isinstance(v, (str, int, float, list, type(None))) else str(v)) for k, v in e.items() if k != "ctx"})
    return out
