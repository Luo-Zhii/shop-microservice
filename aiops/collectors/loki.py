"""Client Loki (query_range log)."""

from __future__ import annotations

import httpx


class LokiError(RuntimeError):
    pass


class LokiClient:
    def __init__(self, base_url: str, timeout: float = 15, transport: httpx.BaseTransport | None = None,
                 headers: dict[str, str] | None = None):
        self.client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, headers=headers)

    def query_range(self, logql: str, start: float, end: float, limit: int = 5000,
                    direction: str = "forward") -> list[tuple[int, dict, str]]:
        """→ [(ts_ns, stream_labels, line)] sắp theo thời gian."""
        params = {"query": logql, "start": str(int(start * 1e9)), "end": str(int(end * 1e9)), "limit": limit,
                  "direction": direction}
        try:
            r = self.client.get("/loki/api/v1/query_range", params=params)
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise LokiError(f"loki: {e}") from e
        if r.status_code >= 400 or data.get("status") != "success":
            raise LokiError(f"loki: HTTP {r.status_code}: {str(data)[:200]}")
        out = []
        for stream in data["data"].get("result", []):
            labels = stream.get("stream", {})
            for ts, line in stream.get("values", []):
                out.append((int(ts), labels, line))
        out.sort(key=lambda x: x[0])
        return out


def stream_service(labels: dict, preferred: str = "service") -> str | None:
    for k in (preferred, "service", "service_name", "app", "app_kubernetes_io_name", "container", "job"):
        if labels.get(k):
            return labels[k]
    return None
