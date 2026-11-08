from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    service_name: str = field(default_factory=lambda: os.getenv("SERVICE_NAME", "ai-service"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8114")))
    database_url: str = field(
        default_factory=lambda: os.getenv("DATABASE_URL", "postgresql://shopnow:shopnow@localhost:55432/ai")
    )
    kafka_enabled: bool = field(default_factory=lambda: _bool("KAFKA_ENABLED", True))
    kafka_brokers: str = field(default_factory=lambda: os.getenv("KAFKA_BROKERS", "localhost:59092"))
    kafka_group: str = field(default_factory=lambda: os.getenv("KAFKA_GROUP_ID", "ai-service"))
    rebuild_interval_s: float = field(default_factory=lambda: float(os.getenv("MODEL_REBUILD_INTERVAL_SECONDS", "30")))
    faq_path: str = field(
        default_factory=lambda: os.getenv("FAQ_PATH", os.path.join(os.path.dirname(__file__), "data", "faq.yaml"))
    )
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "none").lower())
    embeddings_enabled: bool = field(default_factory=lambda: _bool("EMBEDDINGS_ENABLED", False))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "info"))
    otel_endpoint: str | None = field(default_factory=lambda: os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or None)
