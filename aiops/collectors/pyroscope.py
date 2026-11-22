"""Continuous profiling (Grafana Pyroscope) — "trụ cột thứ tư" của observability cho RCA.

Profile CPU thu bằng eBPF (Grafana Alloy `pyroscope.ebpf`, không sửa code service) → Pyroscope. Gọi Connect API
`POST /querier.v1.QuerierService/SelectMergeStacktraces` (start/end: mili-giây) → `flamegraph{names, levels, total}`.
Mỗi level là dãy nhóm 4 số [x offset (delta), total, self, chỉ số tên] (flamebearer "single"); để tìm hàm ngốn CPU chỉ
cần cộng `self` theo tên, không cần giải mã offset.
"""

from __future__ import annotations

from collections import defaultdict

import httpx

CPU = "process_cpu:cpu:nanoseconds:cpu:nanoseconds"


def self_by_function(flamegraph: dict) -> tuple[dict[str, float], float]:
    names = flamegraph.get("names") or []
    acc: dict[str, float] = defaultdict(float)
    for level in flamegraph.get("levels") or []:
        v = [int(x) for x in (level.get("values") or [])]
        for i in range(0, len(v) - 3, 4):
            if 0 <= v[i + 3] < len(names):
                acc[names[v[i + 3]]] += v[i + 2]
    total = float(flamegraph.get("total") or sum(acc.values()) or 0)   # proto3 JSON: int64 có thể là chuỗi
    return dict(acc), total


class PyroscopeClient:
    def __init__(self, base_url: str, timeout: float = 10, transport: httpx.BaseTransport | None = None,
                 service_label: str = "service_name"):
        self.c = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)
        self.label = service_label

    def flamegraph(self, service: str, start: float, end: float, profile_type: str = CPU, max_nodes: int = 2048) -> dict:
        r = self.c.post("/querier.v1.QuerierService/SelectMergeStacktraces",
                        json={"profileTypeID": profile_type, "labelSelector": f'{{{self.label}="{service}"}}',
                              "start": int(start * 1000), "end": int(end * 1000), "maxNodes": max_nodes},
                        headers={"content-type": "application/json"})
        r.raise_for_status()
        return r.json().get("flamegraph") or {}

    def hot_functions(self, service: str, start: float, end: float, baseline_shift_s: float = 86400, k: int = 5) -> dict:
        """Hàm chiếm CPU nhiều nhất trong [start, end] và hàm TĂNG tỉ trọng nhiều nhất so với cùng khung giờ trước đó
        (mặc định hôm qua) — "hàm X từ 3% lên 42% CPU" có ích cho RCA hơn "CPU cao"."""
        cur, cur_total = self_by_function(self.flamegraph(service, start, end))
        base, base_total = self_by_function(self.flamegraph(service, start - baseline_shift_s, end - baseline_shift_s))
        share = lambda d, t, f: (d.get(f, 0.0) / t) if t else 0.0  # noqa: E731
        top = sorted(cur, key=lambda f: -cur[f])[:k]
        grew = sorted(((f, share(cur, cur_total, f) - share(base, base_total, f)) for f in cur), key=lambda x: -x[1])
        row = lambda f: {"function": f, "share": round(share(cur, cur_total, f), 4),  # noqa: E731
                         "baseline_share": round(share(base, base_total, f), 4) if base_total else None}
        return {"service": service, "samples": cur_total, "baseline_samples": base_total,
                "top_self": [row(f) for f in top],
                "regressions": [{**row(f), "delta": round(d, 4)} for f, d in grew[:k] if d >= 0.05 and base_total]}
