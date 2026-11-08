import subprocess
import sys
from pathlib import Path

import httpx

from aiops.ci_assistant.__main__ import analyze, main
from aiops.ci_assistant.redact import redact
from aiops.ci_assistant.rules import classify, clean
from aiops.llm.base import AnthropicProvider

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "ci-failure.log"


def test_redaction_covers_common_secrets():
    gh = "ghp_" + "a1B2" * 9
    text = (f"token {gh}\nAuthorization: Bearer abc.def.ghi123456\npassword=hunter2xyz\n"
            "AKIAIOSFODNN7EXAMPLE\npostgres://u:pw123@h/db\n" + "sk-ant-" + "x" * 30)
    out, counts = redact(text)
    for secret in (gh, "abc.def.ghi123456", "hunter2xyz", "AKIAIOSFODNN7EXAMPLE", "pw123", "x" * 30):
        assert secret not in out
    assert counts["github_token"] == 1 and counts["aws_access_key"] == 1


def test_classify_sample_log():
    cats = classify(clean(SAMPLE.read_text()))
    assert cats[0]["category"] == "typecheck"
    assert {"typecheck", "test_failure", "vulnerability"} <= {c["category"] for c in cats}
    assert "dependency" not in {c["category"] for c in cats}


def test_oom_and_missing_secret():
    assert classify(clean("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"))[0]["category"] == "oom"
    assert classify(clean("Error: Input required and not supplied: registry-password"))[0]["category"] == "missing_secret"


def test_cli_writes_markdown(tmp_path):
    out = tmp_path / "explain.md"
    assert main(["--log", str(SAMPLE), "--context", "repo/ci", "--output", str(out)]) == 0
    md = out.read_text()
    assert "Trợ lý CI" in md and "AKIAIOSFODNN7EXAMPLE" not in md and "supersecretpw" not in md


def test_cli_runs_as_module_from_aiops_dir(tmp_path):
    out = tmp_path / "e.md"
    r = subprocess.run([sys.executable, "-m", "aiops.ci_assistant", "--log", str(SAMPLE), "--context", "x", "--output", str(out)],
                       cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    assert out.exists()


def test_llm_analysis_path(monkeypatch):
    seen = {}

    def h(req):
        seen["body"] = req.content.decode()
        return httpx.Response(200, json={"stop_reason": "end_turn", "content": [{"type": "text", "text": "**Nguyên nhân gốc**: TS2322"}]})

    p = AnthropicProvider("k", transport=httpx.MockTransport(h))
    monkeypatch.setattr("aiops.ci_assistant.__main__.safe_build_provider", lambda *a, **k: p)
    r = analyze(SAMPLE.read_text(), "ctx")
    assert r["provider"] == "anthropic" and "TS2322" in r["llm"]
    assert "AKIAIOSFODNN7EXAMPLE" not in seen["body"]


def test_synthetic_eval_small(tmp_path):
    from aiops.eval.synthetic import run

    s = run(3, 7, tmp_path, 0.6, 2, quiet=True, jobs=1)
    assert (tmp_path / "synthetic_report.md").exists() and (tmp_path / "synthetic_summary.csv").exists()
    assert set(s["methods"]) == {"static", "zscore", "iforest", "aiops"}
    assert s["fault_scenarios"] == 3 and s["rca"]["detected"]["n"] >= 1


def test_chaos_runner_dry_run(tmp_path):
    from aiops.eval.chaos_runner import main as chaos_main

    assert chaos_main(["--dry-run", "--only", "pod-kill", "--out", str(tmp_path)]) == 0
    md = (tmp_path / "chaos_dryrun.md").read_text()
    assert "pod-kill-order" in md and "✓" in md
