"""Kill switch (graceful degradation): runbook → toggle_flag; interlock cho tắt cả giờ đóng băng, cấm bật; executor buộc
qua GitOps; patch + cổng xác minh trên file flags.yaml THẬT của repo gitops; PR chỉ đổi đúng một defaultVariant."""

import base64
from pathlib import Path

import httpx
import pytest

from aiops.agent.executor import Executor
from aiops.agent.gitops_pr import GitHubGitOps, PatchError, build_change, patch_flag, propose_pr, verify
from aiops.agent.investigator import Interlock
from aiops.agent.kube import RecordingBackend
from aiops.agent.runbook import choose_action
from aiops.config import load_settings

GITOPS = Path(__file__).resolve().parents[3] / "shop-gitops"
FLAGS = (GITOPS / "environments/prod-onprem/flags.yaml").read_text() if (GITOPS / "environments").exists() else (
    'featureFlags:\n  recommendations: {state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "on"}   # gw\n'
    '  search-suggest: {state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "on"}\n')
REM = {"action": "toggle_flag", "service": "ai-service", "params": {"flag": "recommendations", "variant": "off"},
       "reason": "ai-service p95 tăng, không có deploy (ev-1, ev-2)"}


def test_runbook_prefers_kill_switch_for_degradable_service():
    rb = load_settings().runbook
    d = choose_action(rb, {"service": "ai-service", "recent_deploy": False, "symptoms": ["p95"], "score": 0.9})
    assert d["action"] == "toggle_flag" and d["params"] == {"flag": "recommendations", "variant": "off"}
    assert d["approval"] == "required"
    # vừa deploy → vẫn rollback trước; service không có tính năng phụ → scale như cũ
    assert choose_action(rb, {"service": "ai-service", "recent_deploy": True, "symptoms": ["p95"]})["action"] == "rollback"
    assert choose_action(rb, {"service": "catalog", "recent_deploy": False, "symptoms": ["p95"]})["action"] == "scale_up"


def test_interlock_allows_turning_off_during_freeze_only():
    lock = Interlock(freeze=[(0, 24)])
    assert lock.check(REM, 0) == (True, "ok")
    assert lock.check({**REM, "action": "scale_up"}, 0)[0] is False
    assert lock.check({**REM, "params": {"flag": "recommendations", "variant": "on"}}, 0) == (False, "tác tử chỉ được đề xuất TẮT flag")


def test_executor_requires_gitops():
    ex = Executor(RecordingBackend(), ["shopnow"], ["rollback"], dry_run=False)
    r = ex.execute({"type": "toggle_flag", "target": {"namespace": "shopnow", "name": "ai-service"}, "params": {"flag": "recommendations"}})
    assert r["result"] == "gitops_required"


def test_patch_and_verify_on_real_flags_file():
    ch = build_change(REM, {"environments/prod-onprem/flags.yaml": FLAGS}, "prod-onprem", [])
    assert ch["path"] == "environments/prod-onprem/flags.yaml" and "kill switch" in ch["title"]
    assert verify(ch, REM, {"ev-1", "ev-2"}, "prod-onprem") == []
    assert 'recommendations: {state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "off"}' in ch["after"]
    assert ch["after"].count('defaultVariant: "off"') == 1   # search-suggest không bị chạm
    with pytest.raises(PatchError):
        patch_flag(ch["after"], "recommendations")        # đã tắt rồi
    with pytest.raises(PatchError):
        patch_flag(FLAGS, "khong-co")

    def tampered(after: str) -> list[str]:
        import difflib
        d = "".join(difflib.unified_diff(FLAGS.splitlines(True), after.splitlines(True), "a/f", "b/f"))
        return verify({**ch, "diff": d}, REM, {"ev-1", "ev-2"}, "prod-onprem")

    # đổi cả state, bật flag khác, đổi flag khác tên → đều bị cổng chặn
    assert tampered(FLAGS.replace('state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "on"}   # gateway',
                                  'state: DISABLED, variants: {"on": true, "off": false}, defaultVariant: "off"}   # gateway', 1))
    other = FLAGS.replace('search-suggest: {state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "on"}',
                          'search-suggest: {state: ENABLED, variants: {"on": true, "off": false}, defaultVariant: "off"}')
    assert any("không phải flag recommendations" in p for p in tampered(other))
    assert verify(ch, {**REM, "reason": "không trích"}, {"ev-1"}, "prod-onprem")


def test_propose_pr_reads_flags_and_opens_pr():
    calls = []

    def handler(req: httpx.Request):
        calls.append((req.method, req.url.path))
        if req.method == "GET" and "/contents/" in req.url.path:
            assert req.url.path.endswith("environments/dev/flags.yaml")
            return httpx.Response(200, json={"content": base64.b64encode(FLAGS.encode()).decode(), "sha": "f1"})
        if req.url.path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": "base"}})
        if req.url.path.endswith("/pulls"):
            return httpx.Response(201, json={"number": 7, "html_url": "https://github.com/x/shop-gitops/pull/7"})
        return httpx.Response(201, json={})

    inv = {"incident_id": "inc-1", "remediation": {**REM, "allowed": True}, "grounding": 1.0, "cost": {},
           "hypotheses": [{"service": "ai-service", "cause": "quá tải", "confidence": 0.6, "evidence": ["ev-1"]}],
           "evidence": [{"id": "ev-1", "tool": "get_anomalies", "ok": True, "data": {}},
                        {"id": "ev-2", "tool": "rank_root_causes", "ok": True, "data": {}}]}
    r = propose_pr(inv, GitHubGitOps("x/shop-gitops", "t", transport=httpx.MockTransport(handler)), "dev")
    assert r["status"] == "proposed" and r["url"].endswith("/pull/7"), r
    assert ("PUT", "/repos/x/shop-gitops/contents/environments/dev/flags.yaml") in calls


def test_eval_oracle_matches_runbook():
    from aiops.eval.simulator import DEGRADABLE

    assert DEGRADABLE == set(load_settings().runbook["degradable"])
