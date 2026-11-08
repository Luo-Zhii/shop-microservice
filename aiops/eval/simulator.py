"""Bộ sinh metric tổng hợp cho ShopNow theo đồ thị gọi, có tiêm lỗi + lan truyền ngược chiều gọi + nhãn.

Mỗi kịch bản: T bước × 30s cho 15 service, 6 đặc trưng thô (p95 s, err, rps, cpu core, mem MB, dlq msg/s).
Lưu lượng gateway có chu kỳ + nhiễu Poisson; lỗi đếm theo nhị thức trên số request (service ít tải nhiễu hơn);
p95 nhiễu log-normal + gai đơn lẻ ngẫu nhiên (nhiễu khó). Lỗi tiêm tại service gốc r trong [t0, t1):
  latency  : p95_r tăng (×1–5 + 20–300ms)            error : err_r += 2–25% (+DLQ nếu r là consumer Kafka)
  cpu      : cpu_r += 0.5–0.9 core, p95_r ×1.5–3     pod_kill: 2 bước đầu lỗi 15–50%, rps giảm, mem rơi, p95 ×1.3
           (30% pod_kill là CrashLoop kéo dài)
Lan truyền theo cạnh sync caller→callee: Δp95_caller = f·Δp95_callee, Δerr_caller = f·0.6–0.95·Δerr_callee,
f = tỉ lệ request của caller đi qua callee. Kịch bản "surge" (lành tính): lưu lượng ×1.6–2.2, không có nhãn lỗi.
Nhãn điểm: service bị ảnh hưởng đáng kể (Δp95 > 30% baseline hoặc Δerr > 1 điểm % hoặc là gốc) trong [t0, t1).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

SERVICES = ["api-gateway", "identity", "user-profile", "seller", "catalog", "search", "inventory", "cart",
            "promotion", "order", "payment", "shipping", "review", "notification", "ai-service"]
# tỉ lệ request của gateway đi tới từng service
GW_SHARE = {"identity": 0.10, "user-profile": 0.08, "seller": 0.04, "catalog": 0.35, "search": 0.20,
            "inventory": 0.10, "cart": 0.12, "promotion": 0.06, "order": 0.05, "payment": 0.03, "shipping": 0.03,
            "review": 0.06, "notification": 0.05, "ai-service": 0.08}
# cạnh sync phụ: caller → {callee: số lời gọi/req}
SUB_CALLS = {"order": {"catalog": 1.0, "shipping": 1.0, "promotion": 1.0, "user-profile": 1.0, "seller": 0.5},
             "cart": {"catalog": 1.0, "inventory": 1.0}, "catalog": {"seller": 0.2}}
BASE_P95 = {"api-gateway": 0.12, "identity": 0.05, "user-profile": 0.03, "seller": 0.03, "catalog": 0.07,
            "search": 0.09, "inventory": 0.02, "cart": 0.04, "promotion": 0.04, "order": 0.35, "payment": 0.06,
            "shipping": 0.05, "review": 0.05, "notification": 0.03, "ai-service": 0.20}
CONSUMERS = {"inventory", "payment", "shipping", "promotion", "cart", "review", "notification", "ai-service",
             "search", "user-profile", "catalog", "identity"}
FAULTS = ("latency", "error", "cpu", "pod_kill")


def sync_edges() -> dict[str, dict[str, float]]:
    """caller → {callee: f} với f = tỉ lệ request của caller phụ thuộc callee (dùng cho lan truyền)."""
    e = {"api-gateway": dict(GW_SHARE)}
    for caller, callees in SUB_CALLS.items():
        e.setdefault(caller, {}).update({c: min(1.0, n) for c, n in callees.items()})
    return e


def topo_order() -> list[str]:
    """Callee trước caller (đồ thị sync là DAG)."""
    edges = sync_edges()
    order, seen = [], set()

    def visit(s):
        if s in seen:
            return
        seen.add(s)
        for c in edges.get(s, {}):
            visit(c)
        order.append(s)

    for s in SERVICES:
        visit(s)
    return order


@dataclass
class Scenario:
    sid: int
    kind: str                 # fault | surge
    fault: str | None
    root: str | None
    t0: int
    t1: int
    raw: dict[str, dict[str, np.ndarray]]
    labels: dict[str, np.ndarray]
    affected: list[str]
    context: dict = field(default_factory=dict)
    expected_action: str | None = None


def simulate(sid: int, rng: np.random.Generator, T: int = 240, train: int = 120, kind: str | None = None,
             fault: str | None = None, root: str | None = None) -> Scenario:
    edges = sync_edges()
    order = topo_order()
    t = np.arange(T)
    kind = kind or ("surge" if rng.random() < 0.15 else "fault")
    # ---- lưu lượng ----
    R = rng.uniform(80, 160) * (1 + 0.15 * np.sin(2 * np.pi * (t / 480.0) + rng.uniform(0, 6.28)))
    t0, t1 = T, T
    if kind == "surge":
        t0 = int(rng.integers(train + 20, T - 40))
        t1 = t0 + int(rng.integers(12, 30))
        ramp = np.clip((t - t0 + 1) / 4.0, 0, 1) * (t < t1)
        R = R * (1 + ramp * (rng.uniform(0.6, 1.2)))
    rps = {s: np.zeros(T) for s in SERVICES}
    rps["api-gateway"] = R.copy()
    for s, share in GW_SHARE.items():
        rps[s] += R * share
    for caller in ("order", "cart", "catalog"):  # thứ tự đủ cho đồ thị hiện tại
        for callee, n in SUB_CALLS[caller].items():
            rps[callee] += rps[caller] * n
    # ---- tham số service ----
    prm = {}
    for s in SERVICES:
        prm[s] = dict(p95=BASE_P95[s] * rng.uniform(0.8, 1.25), err=rng.uniform(0.0005, 0.006),
                      c0=rng.uniform(0.03, 0.12), c1=rng.uniform(0.001, 0.004), m0=rng.uniform(80, 420),
                      sig=rng.uniform(0.07, 0.14))
    # ---- lỗi tiêm ----
    d_own_p95 = {s: np.zeros(T) for s in SERVICES}  # cộng thêm (s)
    mult_p95 = {s: np.ones(T) for s in SERVICES}
    d_own_err = {s: np.zeros(T) for s in SERVICES}
    d_cpu = {s: np.zeros(T) for s in SERVICES}
    mem_mult = {s: np.ones(T) for s in SERVICES}
    rps_mult = {s: np.ones(T) for s in SERVICES}
    dlq_add = {s: np.zeros(T) for s in SERVICES}
    ctx: dict = {}
    expected = None
    if kind == "fault":
        fault = fault or FAULTS[int(rng.integers(len(FAULTS)))]
        root = root or SERVICES[int(rng.integers(len(SERVICES)))]
        t0 = int(rng.integers(train + 20, T - 40))
        crash = fault == "pod_kill" and rng.random() < 0.3
        dur = int(rng.integers(4, 9)) if fault == "pod_kill" and not crash else int(rng.integers(10, 31))
        t1 = min(T, t0 + dur)
        w = (t >= t0) & (t < t1)
        ramp = np.clip((t - t0 + 1) / 2.0, 0, 1) * w
        if fault == "latency":
            d_own_p95[root] += ramp * (prm[root]["p95"] * rng.uniform(1.0, 5.0) + rng.uniform(0.02, 0.3))
        elif fault == "error":
            e = rng.uniform(0.02, 0.25)
            d_own_err[root] += ramp * e
            if root in CONSUMERS:
                dlq_add[root] += ramp * rng.uniform(0.2, 2.0)
        elif fault == "cpu":
            d_cpu[root] += ramp * rng.uniform(0.5, 0.9)
            mult_p95[root] *= 1 + ramp * rng.uniform(0.5, 2.0)
        elif fault == "pod_kill":
            if crash:
                burst = w & (((t - t0) % 4) < 2)  # CrashLoop: lỗi theo đợt mỗi lần pod khởi động lại
            else:
                burst = (t >= t0) & (t < t0 + 2)
            d_own_err[root] += burst * rng.uniform(0.15, 0.5)
            rps_mult[root] *= np.where(burst, rng.uniform(0.5, 0.8), 1.0)
            mem_mult[root] *= np.where(burst, 0.55, 1.0)
            d_cpu[root] += burst * 0.3
            mult_p95[root] *= np.where(w, 1.3, 1.0)
        recent_deploy = bool(fault in ("latency", "error") and rng.random() < 0.6) or bool(fault == "cpu" and rng.random() < 0.2)
        ctx = {"recent_deploy": recent_deploy, "crashloop": crash, "pod_restarted": fault == "pod_kill"}
        if recent_deploy:
            expected = "rollback"
        elif fault == "pod_kill":
            expected = "restart" if crash else "notify"
        elif fault in ("latency", "cpu"):
            expected = "scale_up"
        else:
            expected = "notify"
    # ---- lan truyền: callee trước caller ----
    p95_true = {}
    err_true = {}
    d_p95_total = {s: np.zeros(T) for s in SERVICES}
    d_err_total = {s: np.zeros(T) for s in SERVICES}
    fac = {(u, v): rng.uniform(0.6, 0.95) for u in edges for v in edges[u]}
    for s in order:
        base = prm[s]["p95"]
        own = base * mult_p95[s] + d_own_p95[s] - base  # phần tăng của riêng s
        dp = own.copy()
        de = d_own_err[s].copy()
        for callee, f in edges.get(s, {}).items():
            g = min(1.0, f / 0.15) if s == "api-gateway" else f
            dp += g * fac[(s, callee)] * d_p95_total[callee]
            de += f * fac[(s, callee)] * d_err_total[callee]
        if kind == "surge":  # tải cao → độ trễ tăng nhẹ ở mọi nơi
            load = rps["api-gateway"] / R.mean()
            dp += base * 0.25 * np.clip(load - 1, 0, None)
        d_p95_total[s], d_err_total[s] = dp, de
        p95_true[s] = base + dp
        err_true[s] = np.clip(prm[s]["err"] + de, 0, 1)
    # ---- quan sát có nhiễu ----
    raw: dict[str, dict[str, np.ndarray]] = {}
    labels: dict[str, np.ndarray] = {}
    affected = []
    for s in SERVICES:
        r = np.maximum(rps[s] * rps_mult[s], 0.05)
        n = np.maximum(rng.poisson(r * 30), 1)
        p95 = p95_true[s] * rng.lognormal(0, prm[s]["sig"], T)
        spikes = rng.random(T) < 0.004
        p95 = np.where(spikes, p95 * rng.uniform(1.8, 3.0, T), p95)
        errs = rng.binomial(n, err_true[s]) / n
        cpu = prm[s]["c0"] + prm[s]["c1"] * r + d_cpu[s] + rng.normal(0, 0.01 + 0.05 * prm[s]["c0"], T)
        mem = (prm[s]["m0"] * (1 + 0.0004 * t) + 3 * np.sin(t / 7.0)) * mem_mult[s] + rng.normal(0, 2, T)
        dlq_base = rng.poisson(0.03, T) / 30.0 if s in CONSUMERS else np.zeros(T)  # DLQ hiếm khi có message
        dlq = dlq_base + dlq_add[s]
        raw[s] = {"p95": p95, "err": errs, "rps": n / 30.0, "cpu": np.maximum(cpu, 0), "mem": mem, "dlq": dlq}
        lab = np.zeros(T, dtype=bool)
        if kind == "fault":
            w = (t >= t0) & (t < t1)
            material = (d_p95_total[s] > 0.3 * prm[s]["p95"]) | (d_err_total[s] > 0.01)
            lab = w & (material | (s == root))
            if s == root and fault == "pod_kill":
                lab = w & ((d_own_err[s] > 0) | (mult_p95[s] > 1.0))
            if lab.any():
                affected.append(s)
        labels[s] = lab
    return Scenario(sid, kind, fault, root, t0, t1, raw, labels, affected, ctx, expected)
