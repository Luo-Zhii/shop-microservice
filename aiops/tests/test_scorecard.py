"""Scorecard: mức chỉ lên khi đạt HẾT luật của mức đó; đọc thật từ cấu trúc repo (fixture tối thiểu)."""

import json

import yaml

from aiops.scorecard import evaluate, markdown


def _repo(tmp_path):
    app, gitops = tmp_path / "app", tmp_path / "gitops"
    for svc in ("gold", "bare"):
        (app / f"services/{svc}/test").mkdir(parents=True)
    (app / "services/gold/test/a.test.ts").write_text("// t")
    (app / ".github").mkdir()
    (app / ".github/CODEOWNERS").write_text("/services/gold/ @team-gold\n")
    (app / "scripts/ci").mkdir(parents=True)
    (app / "scripts/ci/services.json").write_text(json.dumps({"images": {"gold": {}, "bare": {}}}))
    (app / "aiops/config").mkdir(parents=True)
    (app / "aiops/config/aiops.yaml").write_text(yaml.safe_dump({
        "services": ["gold"], "kpis": {"gold": {"x": {"direction": "up"}}}, "error_budget": {"slos": {"s1": ["gold"]}}}))
    (gitops / "apps/shopnow/services").mkdir(parents=True)
    (gitops / "apps/shopnow/services/gold.yaml").write_text(yaml.safe_dump({
        "autoscaling": {"enabled": True, "type": "keda"}, "rollout": {"enabled": True}}))
    (gitops / "apps/shopnow/services/bare.yaml").write_text(yaml.safe_dump({"networkPolicy": {"ingress": {"fromSameNamespace": True}}}))
    (gitops / "platform/chaos/experiments").mkdir(parents=True)
    (gitops / "platform/chaos/experiments/x.yaml").write_text("labelSelectors: {app.kubernetes.io/name: gold}\n")
    return app, gitops


def test_levels_require_all_rules(tmp_path):
    rows = {r["service"]: r for r in evaluate(*_repo(tmp_path))}
    assert rows["gold"]["level"] == "gold" and rows["gold"]["score"] == 1.0
    bare = rows["bare"]
    assert bare["level"] == "none"                         # không test, không owner → chưa đạt Bronze
    assert not bare["checks"]["network_policy"]            # mở cả namespace
    assert "Có owner trong CODEOWNERS" in bare["missing"]
    md = markdown(list(rows.values()))
    assert "🥇 Gold" in md and "— chưa đạt" in md and "owner 50%" in md
