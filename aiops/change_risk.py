"""Chấm rủi ro thay đổi trước khi triển khai (change risk scoring) — AIOps cho change management.

Đặc trưng lấy từ diff git (không cần hệ thống ngoài) + lịch sử sự cố của service:
  lines            log1p(số dòng đổi / 100)
  migration        có đổi services/*/migrations/ (thay đổi schema khó rollback)
  shared           có đổi packages/contracts|platform (bán kính ảnh hưởng = mọi service)
  critical         chạm service tiền/đơn: payment, order, accounting, inventory
  no_tests         đổi mã nguồn mà không đổi file test nào
  after_hours      deploy ngoài giờ hành chính / cuối tuần (giờ VN)
  incidents_30d    số sự cố của các service bị chạm trong 30 ngày (min 5) / 5

Mô hình logistic p = σ(b + Σ wᵢ·xᵢ). Trọng số mặc định là prior do người đặt (giải thích được); `fit()` học lại từ lịch sử
(deploy → có sự cố trong 2h hay không) bằng hồi quy logistic có L2. Đầu ra kèm đóng góp từng yếu tố và cấu hình canary đề xuất.

CLI (dùng trong CI cho PR):  python -m aiops.change_risk --base origin/main --head HEAD --output risk.md
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np

VN = timezone(timedelta(hours=7))
FEATURES = ("lines", "migration", "shared", "critical", "no_tests", "after_hours", "incidents_30d")
CRITICAL = ("payment", "order", "accounting", "inventory")
LABEL_VI = {"lines": "cỡ thay đổi", "migration": "migration CSDL", "shared": "đổi thư viện/hợp đồng dùng chung",
            "critical": "chạm service tiền/đơn hàng", "no_tests": "không kèm test", "after_hours": "triển khai ngoài giờ",
            "incidents_30d": "service có sự cố gần đây"}
PRIOR = {"bias": -2.4, "lines": 0.9, "migration": 1.1, "shared": 1.0, "critical": 0.6, "no_tests": 0.7,
         "after_hours": 0.5, "incidents_30d": 0.9}
ROLLOUT = {
    "low": {"steps": [25, 50, 100], "pause_minutes": 2, "approval": "auto"},
    "medium": {"steps": [10, 30, 60, 100], "pause_minutes": 3, "approval": "auto"},
    "high": {"steps": [5, 10, 25, 50, 100], "pause_minutes": 10, "approval": "manual"},
}


@dataclass
class Change:
    files: list[tuple[str, int]]  # (đường dẫn, số dòng đổi)
    when: datetime = field(default_factory=lambda: datetime.now(VN))
    incidents_30d: dict[str, int] = field(default_factory=dict)

    def services(self) -> list[str]:
        out = set()
        for f, _ in self.files:
            m = re.match(r"(?:services|apps)/([\w-]+)/", f)
            if m:
                out.add(m.group(1))
            elif f.startswith("aiops/"):
                out.add("aiops")
        return sorted(out)

    def features(self) -> dict[str, float]:
        paths = [f for f, _ in self.files]
        src = [f for f in paths if re.search(r"\.(ts|tsx|go|py|sql)$", f) and not re.search(r"(test|spec)", f)]
        tests = [f for f in paths if re.search(r"(_test\.go|\.test\.tsx?|/tests?/)", f)]
        svcs = self.services()
        local = self.when.astimezone(VN)
        return {
            "lines": math.log1p(sum(n for _, n in self.files) / 100),
            "migration": float(any(re.match(r"services/[\w-]+/(migrations|internal/db/migrations)/", f) for f in paths)),
            "shared": float(any(f.startswith(("packages/contracts/", "packages/platform/")) for f in paths)),
            "critical": float(any(s in CRITICAL for s in svcs)),
            "no_tests": float(bool(src) and not tests),
            "after_hours": float(local.weekday() >= 5 or not 9 <= local.hour < 17),
            "incidents_30d": min(5, sum(self.incidents_30d.get(s, 0) for s in svcs)) / 5,
        }


def score(x: dict[str, float], w: dict[str, float] | None = None, budget: dict[str, float] | None = None) -> dict:
    """`budget` = {service: tỉ lệ error budget còn lại của SLO} — chính sách error budget (Google SRE) ghi đè mức rủi ro."""
    w = w or PRIOR
    contrib = {k: round(w[k] * x[k], 3) for k in FEATURES}
    z = w["bias"] + sum(contrib.values())
    p = 1 / (1 + math.exp(-z))
    level = "low" if p < 0.2 else "medium" if p < 0.5 else "high"
    top = sorted(((k, v) for k, v in contrib.items() if v > 0), key=lambda kv: -kv[1])
    reasons = [f"{LABEL_VI[k]} (+{v})" for k, v in top[:4]]
    policy = None
    if budget:
        svc, rem = min(budget.items(), key=lambda kv: kv[1])
        if rem <= 0:
            level, policy = "high", f"{svc} đã hết error budget ({rem:.0%}) — đóng băng thay đổi không khẩn cấp, chỉ cho bản vá độ tin cậy"
        elif rem < 0.25 and level == "low":
            level, policy = "medium", f"{svc} còn {rem:.0%} error budget — triển khai chậm hơn"
        if policy:
            reasons.insert(0, policy)
    return {"probability": round(p, 3), "level": level, "features": {k: round(v, 3) for k, v in x.items()},
            "contributions": dict(top), "rollout": ROLLOUT[level], "reasons": reasons,
            "error_budget": budget or {}, "policy": policy}


def fit(X: list[dict[str, float]], y: list[int], l2: float = 0.1, lr: float = 0.3, epochs: int = 2000) -> dict[str, float]:
    """Hồi quy logistic (gradient descent, L2) — học trọng số từ lịch sử deploy → sự cố."""
    A = np.array([[x[k] for k in FEATURES] for x in X], dtype=float)
    t = np.array(y, dtype=float)
    w, b = np.array([PRIOR[k] for k in FEATURES]), PRIOR["bias"]
    for _ in range(epochs):
        p = 1 / (1 + np.exp(-(A @ w + b)))
        g = A.T @ (p - t) / len(t) + l2 * w / len(t)
        w, b = w - lr * g, b - lr * float(np.mean(p - t))
    return {"bias": round(float(b), 4), **{k: round(float(v), 4) for k, v in zip(FEATURES, w)}}


def from_git(base: str, head: str) -> list[tuple[str, int]]:
    out = subprocess.run(["git", "diff", "--numstat", f"{base}...{head}"], capture_output=True, text=True, check=True).stdout
    files = []
    for line in out.splitlines():
        a, d, path = line.split("\t", 2)
        files.append((path, (int(a) if a.isdigit() else 0) + (int(d) if d.isdigit() else 0)))
    return files


def markdown(r: dict, services: list[str]) -> str:
    icon = {"low": "🟢", "medium": "🟡", "high": "🔴"}[r["level"]]
    ro = r["rollout"]
    lines = [f"### {icon} Rủi ro thay đổi: **{r['level']}** (xác suất gây sự cố ≈ {r['probability']:.0%})", "",
             f"Service bị chạm: {', '.join(f'`{s}`' for s in services) or '—'}", ""]
    if r.get("policy"):
        lines += [f"> ⛔ **Chính sách error budget:** {r['policy']}", ""]
    lines += ["| Yếu tố | Đóng góp |", "|---|---|"] + [f"| {LABEL_VI[k]} | +{v} |" for k, v in r["contributions"].items()]
    lines += ["", f"**Canary đề xuất:** {' → '.join(f'{s}%' for s in ro['steps'])}, nghỉ {ro['pause_minutes']} phút/bước, "
              f"duyệt {'thủ công' if ro['approval'] == 'manual' else 'tự động'}.",
              "", "_Mô hình logistic giải thích được (aiops/change_risk.py); trọng số học lại từ lịch sử deploy → sự cố._"]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Chấm rủi ro thay đổi từ git diff")
    ap.add_argument("--base", default="origin/main")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--incidents", help="JSON {service: số sự cố 30 ngày} (vd từ AIOps /incidents)")
    ap.add_argument("--weights", help="JSON trọng số đã fit")
    ap.add_argument("--output")
    a = ap.parse_args(argv)
    ch = Change(from_git(a.base, a.head), incidents_30d=json.load(open(a.incidents)) if a.incidents else {})
    r = score(ch.features(), json.load(open(a.weights)) if a.weights else None)
    md = markdown(r, ch.services())
    if a.output:
        open(a.output, "w", encoding="utf-8").write(md)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main()
