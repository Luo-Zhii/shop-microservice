"""Phân bổ chi phí hạ tầng theo service (FinOps showback → chargeback) và ghi sổ kế toán.

Bài toán doanh nghiệp: hoá đơn cloud là MỘT con số cho cả công ty; kế toán quản trị cần biết mỗi mảng (bán hàng / quản lý)
tốn bao nhiêu để tính giá thành và lợi nhuận bộ phận; báo cáo tài chính cần ghi nhận chi phí ĐÚNG KỲ (hoá đơn về sau ngày
khoá sổ → trích trước). Tách theo nguyên tắc OpenCost:

  chi phí trực tiếp  container_cpu_allocation (core) và container_memory_allocation_bytes do OpenCost xuất, lấy mẫu mỗi
                     giờ trong kỳ → core-giờ, GiB-giờ × đơn giá (bảng giá OpenCost; on-prem = khấu hao quy đổi).
                     Allocation = max(request, usage) — service khai request dư vẫn phải "trả" phần giữ chỗ.
  chi phí dùng chung namespace nền tảng (monitoring, observability, argocd, trivy-system…) chia cho các service THEO TỈ
                     LỆ chi phí trực tiếp — ai dùng nhiều hạ tầng thì gánh nhiều phần giám sát.
  vị trí             nhãn `cluster` ∈ finops.cloud_clusters → cloud (ghi sổ trích trước 6417/6427 / 335);
                     còn lại → on-prem: CHỈ showback, vì máy on-prem đã vào chi phí qua khấu hao TSCĐ (214) — ghi nữa là trùng.
  trung tâm chi phí  finops.cost_centers: service → sales (TK 6417) | admin (TK 6427); không khai → admin.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone

from .rightsizing import DEFAULT_PRICE

VN = timezone(timedelta(hours=7))
GIB = 1024 ** 3
DEFAULT = {"namespace": "shopnow", "shared_namespaces": ["monitoring", "observability", "argocd", "trivy-system", "kube-system"],
           "cloud_clusters": ["prod-aws"], "default_site": "onprem", "fx_vnd_per_usd": 25400, "cost_centers": {}}


def cfg(raw: dict | None) -> dict:
    c = {**DEFAULT, **(raw or {})}
    c["price"] = {**DEFAULT_PRICE, **((raw or {}).get("price") or {})}
    return c


def period_bounds(period: str) -> tuple[float, float]:
    y, m = (int(x) for x in period.split("-"))
    start = datetime(y, m, 1, tzinfo=VN)
    return start.timestamp(), (start + timedelta(days=calendar.monthrange(y, m)[1])).timestamp()


def _series(prom, q: str, keys: tuple[str, ...]) -> dict[tuple, float]:
    out: dict[tuple, float] = {}
    for r in prom.query(q):
        k = tuple(r["metric"].get(x, "") for x in keys)
        v = float(r["value"][1])
        if v == v:
            out[k] = out.get(k, 0.0) + v
    return out


def allocate(prom, period: str, now: float, raw_cfg: dict | None = None) -> dict:
    c = cfg(raw_cfg)
    start, end = period_bounds(period)
    upto = min(end, now)
    hours = max(1, int((upto - start) // 3600))
    rng = f"[{hours}h:1h] @ {int(upto)}"
    shared_ns = "|".join(c["shared_namespaces"])

    def cost(ns_sel: str, by: tuple[str, ...]) -> dict[tuple, float]:
        g = ", ".join(by)
        cpu = _series(prom, f"sum by ({g}) (sum_over_time(container_cpu_allocation{{{ns_sel}}}{rng}))", by)
        mem = _series(prom, f"sum by ({g}) (sum_over_time(container_memory_allocation_bytes{{{ns_sel}}}{rng}))", by)
        out = {}
        for k in set(cpu) | set(mem):
            out[k] = cpu.get(k, 0.0) * c["price"]["cpu_core_hour"] + mem.get(k, 0.0) / GIB * c["price"]["ram_gib_hour"]
        return out

    direct = cost(f'namespace="{c["namespace"]}",container!="",container!="POD"', ("container", "cluster"))
    shared = cost(f'namespace=~"{shared_ns}",container!="",container!="POD"', ("cluster",))
    site = lambda cl: "cloud" if cl in c["cloud_clusters"] else ("onprem" if cl else c["default_site"])  # noqa: E731
    # chia chi phí dùng chung TRONG từng cluster theo tỉ lệ chi phí trực tiếp của service ở cluster đó
    by_cluster: dict[str, float] = {}
    for (svc, cl), v in direct.items():
        by_cluster[cl] = by_cluster.get(cl, 0.0) + v
    rows: dict[tuple[str, str], dict] = {}
    for (svc, cl), v in direct.items():
        sh = shared.get((cl,), 0.0) * (v / by_cluster[cl]) if by_cluster.get(cl) else 0.0
        key = (svc, site(cl))
        r = rows.setdefault(key, {"service": svc, "site": key[1], "direct_usd": 0.0, "shared_usd": 0.0})
        r["direct_usd"] += v
        r["shared_usd"] += sh
    centers = {svc: cc for cc, svcs in (c["cost_centers"] or {}).items() for svc in svcs}
    items = []
    for r in rows.values():
        total = r["direct_usd"] + r["shared_usd"]
        items.append({**r, "direct_usd": round(r["direct_usd"], 2), "shared_usd": round(r["shared_usd"], 2),
                      "total_usd": round(total, 2), "total_vnd": round(total * c["fx_vnd_per_usd"]),
                      "cost_center": centers.get(r["service"], "admin")})
    items.sort(key=lambda x: -x["total_usd"])
    unallocated = {cl: round(v, 2) for (cl,), v in shared.items() if not by_cluster.get(cl)}
    tot = lambda pred: round(sum(i["total_usd"] for i in items if pred(i)), 2)  # noqa: E731
    return {"period": period, "final": now >= end, "hours": hours, "fx_vnd_per_usd": c["fx_vnd_per_usd"], "price": c["price"],
            "items": items, "unallocated_shared_usd": unallocated,
            "totals": {"cloud_usd": tot(lambda i: i["site"] == "cloud"), "onprem_usd": tot(lambda i: i["site"] == "onprem"),
                       "sales_usd": tot(lambda i: i["cost_center"] == "sales"), "admin_usd": tot(lambda i: i["cost_center"] == "admin")}}


def posting_items(report: dict) -> list[dict]:
    """Dòng gửi kế toán: CHỈ phần cloud (on-prem đã nằm trong khấu hao), gộp theo service."""
    out: dict[str, dict] = {}
    for i in report["items"]:
        if i["site"] != "cloud" or i["total_vnd"] <= 0:
            continue
        r = out.setdefault(i["service"], {"service": i["service"], "costCenter": i["cost_center"], "amountVnd": 0})
        r["amountVnd"] += i["total_vnd"]
    return sorted(out.values(), key=lambda x: x["service"])
