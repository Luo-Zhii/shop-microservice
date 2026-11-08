"""Nạp cấu hình YAML + biến môi trường."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config" / "aiops.yaml"
DEFAULT_RUNBOOK = HERE / "config" / "runbook.yaml"


def _bool(v: str | None, default: bool) -> bool:
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    raw: dict[str, Any]
    runbook: dict[str, Any]
    prometheus_url: str = field(default_factory=lambda: os.getenv("PROMETHEUS_URL", "http://localhost:9090"))
    loki_url: str | None = field(default_factory=lambda: os.getenv("LOKI_URL") or None)
    alertmanager_url: str | None = field(default_factory=lambda: os.getenv("ALERTMANAGER_URL") or None)
    public_url: str = field(default_factory=lambda: os.getenv("AIOPS_PUBLIC_URL", "http://localhost:8120"))
    db_url: str = field(default_factory=lambda: os.getenv("AIOPS_DB_URL") or os.getenv("DATABASE_URL")
                                         or f"sqlite:///{os.getenv('AIOPS_DATA_DIR', '.')}/aiops.db")
    # DRY_RUN mặc định true; AUTO_REMEDIATION=true (chart shop-gitops) tương đương DRY_RUN=false
    dry_run: bool = field(default_factory=lambda: _bool(os.getenv("DRY_RUN"), not _bool(os.getenv("AUTO_REMEDIATION"), False)))
    detector_enabled: bool = field(default_factory=lambda: _bool(os.getenv("DETECTOR_ENABLED"), True))
    kube_enabled: bool = field(default_factory=lambda: _bool(os.getenv("KUBE_ENABLED"), False))
    approval_secret: str = field(default_factory=lambda: os.getenv("APPROVAL_SECRET", ""))
    webhook_token: str | None = field(default_factory=lambda: os.getenv("AIOPS_WEBHOOK_TOKEN") or os.getenv("WEBHOOK_TOKEN") or None)
    env: str = field(default_factory=lambda: os.getenv("DEPLOY_ENV", "dev"))
    eval_interval_s: float = field(default_factory=lambda: float(os.getenv("ANOMALY_EVAL_INTERVAL_SECONDS", "0") or 0))
    audit_log: str = field(default_factory=lambda: os.getenv("AUDIT_LOG", "aiops-audit.jsonl"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8120")))

    # ---- tiện ích truy cập ----
    @property
    def namespace(self) -> str:
        return os.getenv("AIOPS_NAMESPACE", self.raw.get("namespace", "shopnow"))

    @property
    def services(self) -> list[str]:
        return list(self.raw.get("services", []))

    @property
    def step(self) -> int:
        return int(self.raw.get("step_seconds", 30))

    def section(self, name: str) -> dict[str, Any]:
        return dict(self.raw.get(name) or {})


def load_settings(config_path: str | os.PathLike | None = None, runbook_path: str | os.PathLike | None = None) -> Settings:
    cfg = Path(config_path or os.getenv("AIOPS_CONFIG", DEFAULT_CONFIG))
    rb = Path(runbook_path or os.getenv("AIOPS_RUNBOOK", DEFAULT_RUNBOOK))
    with open(cfg, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    with open(rb, encoding="utf-8") as f:
        runbook = yaml.safe_load(f) or {}
    return Settings(raw=raw, runbook=runbook)
