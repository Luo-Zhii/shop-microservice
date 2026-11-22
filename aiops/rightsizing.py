"""Right-sizing tài nguyên (FinOps × AIOps × GitOps): requests khai báo so với mức dùng THẬT 7 ngày → đề xuất + tiền tiết kiệm.

Doanh nghiệp hay khai requests dư 2–5 lần "cho chắc" → scheduler giữ chỗ trống, cụm phải thêm node: khoản lãng phí lớn nhất
của Kubernetes. Ngược lại khai thiếu → throttle CPU / OOMKill lúc cao điểm. Quy tắc (giải thích được, không hộp đen):
  CPU    đề xuất = p95 (7 ngày, mỗi 5 phút) × 1.2, làm tròn lên 10m, sàn 20m
  RAM    đề xuất = đỉnh working set 7 ngày × 1.15, làm tròn lên 16Mi, sàn 64Mi, KHÔNG vượt limit hiệu lực
  Chỉ đề xuất khi lệch ≥ 25% và có ≥ 3 ngày dữ liệu; mỗi lần GIẢM tối đa 50% (giảm từng nấc, quan sát rồi giảm tiếp).
  Tiết kiệm/tháng = Δ × số replica × đơn giá (OpenCost mặc định 0.031611 USD/vCPU·giờ, 0.004237 USD/GiB·giờ) × 730.
"""

from __future__ import annotations

import math
import re

MI = 1024 * 1024
HOURS = 730
DEFAULT_PRICE = {"cpu_core_hour": 0.031611, "ram_gib_hour": 0.004237}


def _by_container(prom, q: str) -> dict[str, float]:
    out = {}
    for r in prom.query(q):
        c = r["metric"].get("container")
        v = float(r["value"][1])
        if c and v == v:
            out[c] = v
    return out


def recommend_one(cpu_p95: float, mem_max: float, cur_cpu: float, cur_mem: float, mem_limit: float | None,
                  min_change: float = 0.25, max_cut: float = 0.5) -> dict:
    """cpu tính bằng core, mem bằng byte. Trả đề xuất đã kẹp theo quy tắc an toàn."""
    want_cpu = max(0.02, math.ceil(cpu_p95 * 1.2 * 100) / 100)          # nấc 10m
    want_mem = max(64 * MI, math.ceil(mem_max * 1.15 / (16 * MI)) * 16 * MI)
    rec_cpu = max(want_cpu, cur_cpu * (1 - max_cut)) if want_cpu < cur_cpu else want_cpu
    rec_mem = max(want_mem, cur_mem * (1 - max_cut)) if want_mem < cur_mem else want_mem
    capped = False
    if mem_limit and rec_mem > mem_limit:
        rec_mem, capped = mem_limit, True
    ch_cpu = (rec_cpu - cur_cpu) / cur_cpu if cur_cpu else 0
    ch_mem = (rec_mem - cur_mem) / cur_mem if cur_mem else 0
    act_cpu, act_mem = abs(ch_cpu) >= min_change, abs(ch_mem) >= min_change
    return {"cpu": rec_cpu if act_cpu else cur_cpu, "mem": rec_mem if act_mem else cur_mem,
            "change_cpu": round(ch_cpu, 3) if act_cpu else 0.0, "change_mem": round(ch_mem, 3) if act_mem else 0.0,
            "actionable": act_cpu or act_mem, "mem_capped_at_limit": capped,
            "staged": (want_cpu < rec_cpu - 1e-9) or (want_mem < rec_mem - 1)}   # còn giảm tiếp được ở lần sau


def analyze(prom, namespace: str = "shopnow", price: dict | None = None, min_days: float = 3.0) -> dict:
    price = {**DEFAULT_PRICE, **(price or {})}
    sel = f'namespace="{namespace}",container!="",container!="POD"'
    cpu_p95 = _by_container(prom, f"max by (container) (quantile_over_time(0.95, "
                                  f"sum by (container, pod) (rate(container_cpu_usage_seconds_total{{{sel}}}[5m]))[7d:5m]))")
    mem_max = _by_container(prom, f"max by (container) (max_over_time(container_memory_working_set_bytes{{{sel}}}[7d]))")
    days = _by_container(prom, f"max by (container) (count_over_time(container_memory_working_set_bytes{{{sel}}}[7d:1h])) / 24")
    req_cpu = _by_container(prom, f'max by (container) (kube_pod_container_resource_requests{{namespace="{namespace}",resource="cpu"}})')
    req_mem = _by_container(prom, f'max by (container) (kube_pod_container_resource_requests{{namespace="{namespace}",resource="memory"}})')
    lim_mem = _by_container(prom, f'max by (container) (kube_pod_container_resource_limits{{namespace="{namespace}",resource="memory"}})')
    replicas = _by_container(prom, f'count by (container) (kube_pod_container_info{{namespace="{namespace}"}})')
    items, total = [], 0.0
    for c in sorted(set(req_cpu) & set(cpu_p95) & set(mem_max)):
        enough = days.get(c, 0) >= min_days
        rec = recommend_one(cpu_p95[c], mem_max[c], req_cpu[c], req_mem.get(c, 0), lim_mem.get(c))
        n = replicas.get(c, 1)
        saving = ((req_cpu[c] - rec["cpu"]) * price["cpu_core_hour"]
                  + (req_mem.get(c, 0) - rec["mem"]) / (1024 * MI) * price["ram_gib_hour"]) * n * HOURS
        actionable = rec["actionable"] and enough
        if actionable:
            total += saving
        items.append({
            "service": c, "replicas": int(n), "days_of_data": round(days.get(c, 0), 1), "enough_data": enough,
            "usage": {"cpu_p95_m": round(cpu_p95[c] * 1000), "mem_max_mi": round(mem_max[c] / MI)},
            "current": {"cpu_m": round(req_cpu[c] * 1000), "mem_mi": round(req_mem.get(c, 0) / MI)},
            "recommended": {"cpu_m": round(rec["cpu"] * 1000), "mem_mi": round(rec["mem"] / MI)},
            "change": {"cpu": rec["change_cpu"], "mem": rec["change_mem"]},
            "direction": ("increase" if rec["change_cpu"] > 0 or rec["change_mem"] > 0 else "decrease") if actionable else "keep",
            "monthly_saving_usd": round(saving, 2) if actionable else 0.0,
            "mem_capped_at_limit": rec["mem_capped_at_limit"], "staged": rec["staged"] and actionable,
        })
    items.sort(key=lambda x: (x["direction"] == "keep", -abs(x["monthly_saving_usd"])))
    return {"namespace": namespace, "price": price, "monthly_saving_usd": round(total, 2), "items": items}


# ---------------------------------------------------------------- bản vá GitOps (apps/shopnow/services/<svc>.yaml)
REQ_LINE = re.compile(r"^(?P<indent>\s+)requests:\s*\{cpu:\s*(?P<cpu>[^,}]+),\s*memory:\s*(?P<mem>[^}]+)\}(?P<tail>\s*(#.*)?)$")


def _cpu_m(v: str) -> float:
    v = v.strip().strip('"')
    return float(v[:-1]) if v.endswith("m") else float(v) * 1000


def _mem_mi(v: str) -> float:
    v = v.strip().strip('"')
    return float(v[:-2]) * 1024 if v.endswith("Gi") else float(v[:-2])


def patch_requests(text: str, cpu_m: int, mem_mi: int) -> str:
    lines, hit = text.splitlines(), False
    for i, ln in enumerate(lines):
        m = REQ_LINE.match(ln)
        if m:
            lines[i] = f"{m['indent']}requests: {{cpu: {cpu_m}m, memory: {mem_mi}Mi}}{m['tail'] or ''}"
            hit = True
            break
    if not hit:   # service đang dùng mức chung của values-common → thêm khối riêng (Helm deep-merge giữ limits chung)
        lines += ["resources:", f"  requests: {{cpu: {cpu_m}m, memory: {mem_mi}Mi}}   # right-sizing (AIOps)"]
    return "\n".join(lines) + "\n"


def verify_patch(diff: str, path: str, service: str, current: dict, max_cut: float = 0.5) -> list[str]:
    """Cổng xác minh PR right-sizing: đúng file của service, chỉ đổi dòng requests, mỗi lần giảm ≤ 50%."""
    problems = []
    if path != f"apps/shopnow/services/{service}.yaml":
        problems.append(f"file {path} không phải của {service}")
    changed = [ln for ln in diff.splitlines() if ln[:1] in "+-" and not ln.startswith(("+++", "---"))]
    plus = [ln[1:] for ln in changed if ln.startswith("+")]
    minus = [ln[1:] for ln in changed if ln.startswith("-")]
    if not plus:
        problems.append("diff rỗng")
    for ln in minus + plus:
        if not (REQ_LINE.match(ln) or ln.strip() == "resources:"):
            problems.append(f"dòng đổi ngoài requests: {ln.strip()[:80]}")
    for ln in plus:
        m = REQ_LINE.match(ln)
        if m:
            if _cpu_m(m["cpu"]) < current["cpu_m"] * (1 - max_cut) - 1e-6 or _mem_mi(m["mem"]) < current["mem_mi"] * (1 - max_cut) - 1e-6:
                problems.append("giảm quá 50% trong một lần — phải giảm từng nấc")
    return problems
