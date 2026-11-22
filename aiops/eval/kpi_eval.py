"""Thực nghiệm: detector hạ tầng (6 đặc trưng) so với hạ tầng + KPI có hướng, trên sự cố "câm".

Sự cố câm = hạ tầng vẫn bình thường (HTTP 200, p95 ổn) nhưng người dùng/kinh doanh bị ảnh hưởng:
  checkout_bug       đơn tạo/giây ở service order sụt 90%, rps/p95/err không đổi
  checkout_partial   chỉ một phần người dùng bị lỗi (vd một phương thức thanh toán): đơn sụt 30–50% — kiểm giới hạn độ nhạy
  lcp_regression     LCP p75 của web tăng lên 4–7s (bundle phình, ảnh không nén)
  credential_stuff   đăng nhập thất bại/giây ở identity tăng 20–60× (rải nhiều IP nên rate limit theo IP không chặn)
Đối chứng (không phải sự cố):
  normal             mọi chuỗi chỉ có nhiễu
  legit_surge        flash sale: rps ×3 và đơn ×3 cùng lúc (tải tăng hợp lệ)

Mỗi kịch bản: 120 bước (30s), 5 bước cuối là giai đoạn sự cố; chấm bằng DetectorEngine.evaluate thật (cùng code
production), ngưỡng báo = điểm ≥ ngưỡng alert của config. "infra" = engine với kpis rỗng; "infra+kpi" = config thật.
Chạy: python -m aiops.eval.kpi_eval --per-kind 20 --out aiops/eval/results
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import numpy as np

from ..config import load_settings
from ..engine import DetectorEngine

T, TAIL = 120, 5
INFRA = {"rps": 50.0, "p95": 0.12, "err": 0.002, "cpu": 0.25, "mem": 220.0, "dlq": 0.0}
KINDS = ("checkout_bug", "lcp_regression", "credential_stuff", "checkout_partial", "normal", "legit_surge")
SILENT = KINDS[:4]
TARGET = {"checkout_bug": "order", "lcp_regression": "web", "credential_stuff": "identity", "checkout_partial": "order",
          "normal": None, "legit_surge": None}


def _noise(rng, level, rel=0.04):
    return np.abs(level + rng.normal(0, level * rel + 1e-6, T))


def scenario(kind: str, rng: np.random.Generator) -> dict[str, dict[str, np.ndarray]]:
    infra = {svc: {k: _noise(rng, v) for k, v in INFRA.items()} for svc in ("order", "identity", "api-gateway")}
    data = {**infra,
            "order": {**infra["order"], "orders": _noise(rng, 5.0, 0.08)},
            "identity": {**infra["identity"], "auth_fail": _noise(rng, 0.05, 0.3)},
            "web": {"lcp": _noise(rng, 1.8, 0.04), "jserr": _noise(rng, 0.02, 0.3)}}
    tail = slice(T - TAIL, T)
    if kind == "checkout_bug":
        data["order"]["orders"][tail] *= rng.uniform(0.05, 0.15)
    elif kind == "checkout_partial":
        data["order"]["orders"][tail] *= rng.uniform(0.5, 0.7)
    elif kind == "lcp_regression":
        data["web"]["lcp"][tail] = rng.uniform(4.0, 7.0, TAIL)
    elif kind == "credential_stuff":
        data["identity"]["auth_fail"][tail] = 0.05 * rng.uniform(20, 60, TAIL)
    elif kind == "legit_surge":
        for svc in ("order", "api-gateway"):
            data[svc]["rps"][tail] *= 3
        data["order"]["orders"][tail] *= 3
    return data


def run(per_kind: int, seed: int, out: Path | None = None) -> dict:
    s_kpi = load_settings()
    s_kpi.raw["logs"]["enabled"] = False
    s_infra = copy.deepcopy(s_kpi)
    s_infra.raw["kpis"] = {}
    thr = DetectorEngine(s_kpi, prom=None, loki=None, alerts=None).thr  # cùng ngưỡng alert với production
    rng = np.random.default_rng(seed)
    res = {m: {k: {"hit": 0, "fp": 0, "n": 0} for k in KINDS} for m in ("infra", "infra+kpi")}
    for kind in KINDS:
        for _ in range(per_kind):
            data = scenario(kind, rng)
            for mode, st in (("infra", s_infra), ("infra+kpi", s_kpi)):
                snap = DetectorEngine(st, prom=None, loki=None, alerts=None).evaluate(1_800_000_000.0, data=data, log_lines=[])
                flagged = {svc for svc, v in snap.services.items() if v.score >= thr and svc in data}
                r = res[mode][kind]
                r["n"] += 1
                tgt = TARGET[kind]
                if tgt and tgt in flagged:
                    r["hit"] += 1
                if flagged - ({tgt} if tgt else set()):
                    r["fp"] += 1
    summary = {"per_kind": per_kind, "seed": seed, "threshold": thr, "results": res,
               "recall_silent": {m: round(sum(res[m][k]["hit"] for k in SILENT) / (len(SILENT) * per_kind), 3) for m in res},
               "recall_by_kind": {m: {k: round(res[m][k]["hit"] / per_kind, 3) for k in SILENT} for m in res},
               "false_alarm_rate": {m: round(sum(res[m][k]["fp"] for k in KINDS) / (len(KINDS) * per_kind), 3) for m in res}}
    if out:
        out.mkdir(parents=True, exist_ok=True)
        (out / "kpi_eval_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--per-kind", type=int, default=20)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "results")
    a = ap.parse_args(argv)
    print(json.dumps(run(a.per_kind, a.seed, a.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
