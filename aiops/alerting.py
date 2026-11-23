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


    def create_silence(self, service_regex: str, starts_at: float, ends_at: float, created_by: str, comment: str) -> str | None:
        """Silence theo nhãn service (regex) cho khung bảo trì — Alertmanager nhận cả silence TƯƠNG LAI (startsAt sau hiện tại)."""
        from datetime import datetime, timezone

        iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
        body = {"matchers": [{"name": "service", "value": service_regex, "isRegex": True, "isEqual": True}],
                "startsAt": iso(starts_at), "endsAt": iso(ends_at), "createdBy": created_by, "comment": comment[:500]}
        try:
            r = self.client.post("/api/v2/silences", json=body)
            r.raise_for_status()
            return r.json().get("silenceID")
        except (httpx.HTTPError, ValueError) as e:
            log.error("không tạo được silence: %s", e)
            return None

    def expire_silence(self, silence_id: str) -> bool:
        try:
            r = self.client.delete(f"/api/v2/silence/{silence_id}")
            return r.status_code < 300
        except httpx.HTTPError as e:
            log.error("không gỡ được silence %s: %s", silence_id, e)
            return False


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
