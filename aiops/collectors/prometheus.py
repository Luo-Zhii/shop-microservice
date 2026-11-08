"""Client Prometheus HTTP API (query, query_range) + căn chỉnh về lưới thời gian."""

from __future__ import annotations

import numpy as np
import httpx


class PrometheusError(RuntimeError):
    pass


class PrometheusClient:
    def __init__(self, base_url: str, timeout: float = 15, transport: httpx.BaseTransport | None = None,
                 headers: dict[str, str] | None = None):
        self.client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport, headers=headers)

    def _get(self, path: str, params: dict) -> list[dict]:
        try:
            r = self.client.get(path, params=params)
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise PrometheusError(f"prometheus: {e}") from e
        if r.status_code >= 400 or data.get("status") != "success":
            raise PrometheusError(f"prometheus: {data.get('errorType')}: {data.get('error')}")
        return data["data"]["result"]

    def query(self, q: str, time: float | None = None) -> list[dict]:
        p = {"query": q}
        if time is not None:
            p["time"] = f"{time:.3f}"
        return self._get("/api/v1/query", p)

    def query_range(self, q: str, start: float, end: float, step: int) -> list[dict]:
        return self._get("/api/v1/query_range", {"query": q, "start": f"{start:.3f}", "end": f"{end:.3f}", "step": step})

    def range_by_label(self, q: str, start: float, end: float, step: int, label: str = "service") -> tuple[np.ndarray, dict[str, np.ndarray]]:
        """→ (grid timestamps, {giá trị nhãn: mảng giá trị trên lưới, NaN nếu thiếu})."""
        grid = np.arange(start, end + 1e-9, step, dtype=float)
        out: dict[str, np.ndarray] = {}
        for series in self.query_range(q, start, end, step):
            key = series.get("metric", {}).get(label)
            if key is None:
                continue
            arr = out.setdefault(key, np.full(len(grid), np.nan))
            for ts, val in series.get("values", []):
                i = int(round((float(ts) - start) / step))
                if 0 <= i < len(grid):
                    try:
                        v = float(val)
                    except ValueError:
                        continue
                    arr[i] = v if np.isfinite(v) else np.nan
        return grid, out

    def instant_by_label(self, q: str, label: str = "service") -> dict[str, float]:
        out = {}
        for s in self.query(q):
            key = s.get("metric", {}).get(label)
            if key is not None:
                try:
                    out[key] = float(s["value"][1])
                except (KeyError, ValueError, IndexError):
                    pass
        return out
