"""Service scorecard / production readiness — chấm tự động, liên tục từ chính hai repo (không khai báo tay).

Mỗi service chấm theo luật đạt/không; đạt hết luật của một mức mới lên mức đó (Bronze → Silver → Gold, như Port/Cortex):
  Bronze  có test · có cấu hình triển khai (Helm values) · có trong CI build · có owner (CODEOWNERS)
  Silver  NetworkPolicy bật + ingress không mở cả namespace · autoscaling · được AIOps giám sát · có SLO ràng buộc (error budget)
  Gold    canary rollout · có thí nghiệm chaos nhắm vào · có KPI nghiệp vụ/UX có hướng
Chạy: python -m aiops.scorecard --gitops ../shop-gitops --out docs/platform/scorecard.md
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml

LEVELS = ("bronze", "silver", "gold")
RULES: list[tuple[str, str, str]] = [  # (key, mức, mô tả)
    ("tests", "bronze", "Có test tự động"),
    ("deploy_config", "bronze", "Có Helm values trong repo GitOps"),
    ("ci_build", "bronze", "Được CI build + ký image"),
    ("owner", "bronze", "Có owner trong CODEOWNERS"),
    ("network_policy", "silver", "NetworkPolicy bật, ingress không mở cả namespace"),
    ("autoscaling", "silver", "Có autoscaling (HPA/KEDA)"),
    ("aiops_monitored", "silver", "AIOps giám sát (có trong danh sách service)"),
    ("slo", "silver", "Có SLO ràng buộc (error budget)"),
    ("canary", "gold", "Triển khai canary (Argo Rollouts)"),
    ("chaos", "gold", "Có thí nghiệm chaos nhắm vào"),
    ("kpi", "gold", "Có KPI nghiệp vụ/UX có hướng"),
]


def _load(p: Path) -> dict:
    return yaml.safe_load(p.read_text()) or {} if p.exists() else {}


def _codeowners(root: Path) -> list[str]:
    for p in (root / ".github/CODEOWNERS", root / "CODEOWNERS"):
        if p.exists():
            return [ln.split()[0] for ln in p.read_text().splitlines() if ln.strip() and not ln.startswith("#") and len(ln.split()) > 1]
    return []


def evaluate(app_root: Path, gitops_root: Path) -> list[dict]:
    aiops = _load(app_root / "aiops/config/aiops.yaml")
    ci = json.loads((app_root / "scripts/ci/services.json").read_text()) if (app_root / "scripts/ci/services.json").exists() else {}
    images = set((ci.get("images") or {}).keys())
    owners = _codeowners(app_root)
    monitored = set(aiops.get("services") or [])
    slo_svcs = {s for svcs in ((aiops.get("error_budget") or {}).get("slos") or {}).values() for s in svcs}
    kpi_svcs = set((aiops.get("kpis") or {}).keys())
    chaos_dir = gitops_root / "platform/chaos/experiments"
    chaos_text = " ".join(p.read_text() for p in chaos_dir.glob("*.yaml")) if chaos_dir.exists() else ""
    env_rollout = any((_load(p).get("rollout") or {}).get("enabled") for p in (gitops_root / "environments").glob("*/values.yaml"))
    out = []
    for svc_dir in sorted(p for p in (app_root / "services").iterdir() if p.is_dir()):
        svc = svc_dir.name
        values = _load(gitops_root / f"apps/shopnow/services/{svc}.yaml")
        ing = ((values.get("networkPolicy") or {}).get("ingress") or {})
        checks = {
            "tests": any(svc_dir.glob("test/**/*.test.ts")) or any(svc_dir.glob("**/*_test.go")) or any(svc_dir.glob("tests/test_*.py")),
            "deploy_config": bool(values),
            "ci_build": svc in images,
            "owner": any(re.fullmatch(o.rstrip("/").replace("*", ".*").lstrip("/") + "(/.*)?", f"services/{svc}") or o in ("*", "/")
                         for o in owners),
            # chart mặc định bật NetworkPolicy (default-deny, chỉ gateway vào) → đạt trừ khi tắt hẳn hoặc mở cả namespace
            "network_policy": (values.get("networkPolicy") or {}).get("enabled", True) is not False and not ing.get("fromSameNamespace"),
            "autoscaling": bool(values.get("autoscaling")),
            "aiops_monitored": svc in monitored,
            "slo": svc in slo_svcs,
            "canary": bool((values.get("rollout") or {}).get("enabled")) or (env_rollout and "rollout" in values),
            "chaos": f"app.kubernetes.io/name: {svc}" in chaos_text or f"expected-root-cause: {svc}" in chaos_text,
            "kpi": svc in kpi_svcs,
        }
        level = "none"
        for lv in LEVELS:
            if all(checks[k] for k, l, _ in RULES if l == lv):
                level = lv
            else:
                break
        passed = sum(checks.values())
        out.append({"service": svc, "level": level, "score": round(passed / len(RULES), 3), "checks": checks,
                    "missing": [d for k, _, d in RULES if not checks[k]]})
    return out


def markdown(rows: list[dict]) -> str:
    icon = {"gold": "🥇 Gold", "silver": "🥈 Silver", "bronze": "🥉 Bronze", "none": "— chưa đạt"}
    head = "| Service | Mức | Điểm | " + " | ".join(k for k, _, _ in RULES) + " |"
    lines = ["# Service scorecard (sinh tự động bởi `python -m aiops.scorecard`)", "",
             "Luật: " + "; ".join(f"**{k}** ({l}) {d}" for k, l, d in RULES) + ".", "", head,
             "|" + "---|" * (3 + len(RULES))]
    for r in rows:
        lines.append(f"| {r['service']} | {icon[r['level']]} | {r['score']:.0%} | "
                     + " | ".join("✓" if r["checks"][k] else "·" for k, _, _ in RULES) + " |")
    pct = {k: sum(r["checks"][k] for r in rows) / len(rows) for k, _, _ in RULES}
    lines += ["", "Tỉ lệ service đạt từng luật: " + ", ".join(f"{k} {v:.0%}" for k, v in pct.items()) + "."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Service scorecard / production readiness")
    ap.add_argument("--app", type=Path, default=Path(__file__).resolve().parents[1])
    ap.add_argument("--gitops", type=Path, default=Path(__file__).resolve().parents[2] / "shop-gitops")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    rows = evaluate(a.app, a.gitops)
    text = json.dumps(rows, ensure_ascii=False, indent=2) if a.json else markdown(rows)
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
