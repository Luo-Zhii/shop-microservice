"""Đẩy alert lên Alertmanager API v2 (POST /api/v2/alerts)."""

from __future__ import annotations

import logging

import httpx

from .metrics import ALERTS_SENT
from .util import iso

log = logging.getLogger("aiops.alerting")


class AlertmanagerClient:
    def __init__(self, base_url: str, transport: httpx.BaseTransport | None = None, timeout: float = 10):
        self.client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)

    def post(self, alerts: list[dict]) -> bool:
        if not alerts:
            return True
        try:
            r = self.client.post("/api/v2/alerts", json=alerts)
        except httpx.HTTPError as e:
            log.error("không gửi được alert: %s", e)
            return False
        if r.status_code >= 300:
            log.error("Alertmanager trả %s: %s", r.status_code, r.text[:200])
            return False
        return True


def build_alert(alertname: str, service: str, namespace: str, score: float, starts_at: float, ends_at: float,
                top_features: list, generator_url: str, firing: bool, env: str | None = None) -> dict:
    sev = "critical" if score >= 0.85 else "warning"
    feats = ", ".join(f"{f}={v}" for f, v in top_features) or "-"
    ALERTS_SENT.labels("firing" if firing else "resolved").inc()
    return {
        "labels": {"alertname": alertname, "service": service, "namespace": namespace, "severity": sev, "source": "aiops",
                   **({"env": env} if env else {})},
        "annotations": {"summary": f"AIOps phát hiện {service} bất thường (điểm {score:.2f})",
                        "description": f"Đặc trưng lệch nhiều nhất: {feats}", "score": f"{score:.3f}",
                        "onset": iso(starts_at) or ""},
        "startsAt": iso(starts_at),
        "endsAt": iso(ends_at),
        "generatorURL": generator_url,
    }
