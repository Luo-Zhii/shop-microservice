"""Đánh giá tác tử điều tra (agentic RCA) trên kịch bản tổng hợp — cùng bộ sinh với eval/synthetic.py.

Mỗi kịch bản lỗi: sinh metric 15 service → chấm điểm bất thường → dựng "thế giới" cho tác tử (snapshot detector, triển khai
gần đây, sức khoẻ pod theo ngữ cảnh kịch bản, sự cố mở ở service có triệu chứng mạnh nhất) → chạy Investigator.

Ba cấu hình:
  planner           tác tử tất định (không LLM)
  llm_halluc        LLM giả lập "ảo giác": 40% kịch bản kết luận sai nguyên nhân với bằng chứng bịa (ev-99), kèm giả thuyết
                    đúng có bằng chứng thật — đo bộ lọc grounding có chặn được không
  llm_halluc_nogate cùng LLM nhưng tắt lọc grounding (ablation) — giả thuyết bịa được chấp nhận

Chỉ số: top-1 nguyên nhân gốc, hành động đúng (so expected_action), grounding, tỉ lệ chấp nhận ảo giác, số lần gọi công cụ.
Chạy: python -m aiops.eval.agent_eval --scenarios 30 --out aiops/eval/results
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import tempfile
import time
from pathlib import Path

import numpy as np

from ..agent.investigator import Investigator
from ..agent.kube import StaticInspector
from ..agent.store import IncidentStore
from ..config import load_settings
from ..engine import ServiceState, Snapshot
from ..llm import LLMProvider
from .simulator import SERVICES
from .synthetic import TRAIN, _simulate_and_score

FEATS = ("p95", "err", "rps", "cpu", "mem", "dlq")


class _Engine:
    def __init__(self, snap):
        self.snap = snap

    def latest(self, max_age: float = 120):
        return self.snap


class _World:
    """Tối thiểu những gì Toolbox/Investigator cần từ Responder."""

    def __init__(self, settings, store, inspector, engine, now):
        self.s, self.store, self.inspector, self.engine = settings, store, inspector, engine
        self.prom = self.loki = None
        self.clock = lambda: now

    def _scores_for_rca(self, inc, ctx):
        scores = dict(ctx.get("_scores") or {})
        for a in inc.get("alerts") or []:
            svc = (a.get("labels") or {}).get("service")
            if svc:
                scores[svc] = max(scores.get(svc, 0.0), 0.7)
        return scores


class HallucinatingLLM(LLMProvider):
    """Gọi 2 công cụ thật rồi kết luận. Khi `lie`: thêm giả thuyết sai độ tin cao, trích bằng chứng không tồn tại."""

    name, available = "halluc", True

    def __init__(self, inc_id, root, wrong, lie):
        self.inc_id, self.root, self.wrong, self.lie, self.turn = inc_id, root, wrong, lie, 0

    def chat(self, messages, system=None, max_tokens=1024):
        self.turn += 1
        if self.turn == 1:
            return json.dumps({"thought": "xếp hạng", "tool": "rank_root_causes", "args": {"incident_id": self.inc_id}})
        if self.turn == 2:
            return json.dumps({"thought": "deploy", "tool": "recent_deployments", "args": {"minutes": 60}})
        hyps = [{"service": self.root, "cause": "theo xếp hạng RCA", "confidence": 0.6, "evidence": ["ev-1"]}]
        if self.lie:
            hyps.insert(0, {"service": self.wrong, "cause": "bịa: lỗi cấu hình mạng", "confidence": 0.95, "evidence": ["ev-99"]})
        return json.dumps({"final": {"hypotheses": hyps,
                                     "remediation": {"action": "notify", "service": hyps[0]["service"], "reason": "ev-1"}}})


def world_for(sc, scores, settings, tmp: Path, t_det: int):
    now = 1_800_000_000.0
    lo = max(TRAIN, t_det - 20)
    services = {}
    for s in SERVICES:
        z = scores[s].z[t_det]
        services[s] = ServiceState(score=float(scores[s].combined[max(lo, t_det - 2):t_det + 3].max()),
                                   top_features=sorted([(f, round(float(v), 2)) for f, v in zip(FEATS, z) if v > 0],
                                                       key=lambda x: -x[1])[:3],
                                   signal=list(map(float, scores[s].zmax[lo:t_det + 3])))
    snap = Snapshot(now, services)
    ctx = sc.context or {}
    changes = ([{"kind": "Deployment", "name": sc.root, "revision": 9, "changed_at": now - 600,
                 "images": [f"{sc.root}:sha-new"], "previous_images": [f"{sc.root}:sha-old"]}] if ctx.get("recent_deploy") else [])
    health = {sc.root: {"crashloop": bool(ctx.get("crashloop")), "pod_restarted": bool(ctx.get("pod_restarted"))}}
    store = IncidentStore(f"sqlite:///{tmp / 'agent_eval.db'}")
    # sự cố mở ở service có triệu chứng mạnh nhất (alert thường bắn ở chỗ người dùng thấy, không phải ở gốc)
    symptom = max(sc.affected or [sc.root], key=lambda s: services[s].score)
    inc = store.create_incident(service=symptom, namespace=settings.namespace, severity="critical", title=f"{symptom} bất thường",
                                source="synthetic", detected_at=now,
                                alerts=[{"fingerprint": f"fp-{symptom}", "alertname": "HighErrorRate" if sc.fault == "error" else
                                         "HighLatency", "labels": {"service": symptom}}])
    return _World(settings, store, StaticInspector(changes=changes, health=health), _Engine(snap), now), inc, symptom


def noise_reduction(n: int, seed: int, settings) -> dict:
    """Mỗi service bị ảnh hưởng bắn 1 alert (theo thứ tự điểm bất thường giảm dần): đếm sự cố khi tắt/bật gom theo topology
    (cạnh gọi đồng bộ, như Responder._correlated) và tỉ lệ kịch bản mà service gốc nằm trong sự cố chính."""
    sync = (settings.raw.get("graph") or {}).get("sync") or {}
    edges = {frozenset((a, b)) for a, bs in sync.items() for b in bs}
    rng = np.random.default_rng(seed)
    seeds = rng.integers(0, 2**31 - 1, size=n)
    off = on = scen = root_kept = 0
    for sid in range(n):
        sc, scores = _simulate_and_score((sid, int(seeds[sid]), seed))
        if sc.kind != "fault":
            continue
        svcs = sorted(set(sc.affected) | {sc.root}, key=lambda s: -float(scores[s].combined[sc.t0 + 3]))
        incidents: list[list[str]] = []
        for s in svcs:
            home = next((i for i in incidents if frozenset((s, i[0])) in edges), None)
            (home.append(s) if home else incidents.append([s]))
        scen += 1
        off += len(svcs)
        on += len(incidents)
        root_kept += int(sc.root in incidents[0])  # gốc nằm trong sự cố chính (nơi RCA/tác tử chạy)
    return {"scenarios": scen, "incidents_without": off, "incidents_with": on,
            "reduction": round(1 - on / max(1, off), 3), "root_in_main_incident": round(root_kept / max(1, scen), 3)}


def run(n: int, seed: int, out: Path) -> dict:
    settings = load_settings()
    rng = np.random.default_rng(seed)
    seeds = rng.integers(0, 2**31 - 1, size=n)
    rows = []
    t0 = time.perf_counter()
    with tempfile.TemporaryDirectory() as td:
        for sid in range(n):
            sc, scores = _simulate_and_score((sid, int(seeds[sid]), seed))
            if sc.kind != "fault":
                continue
            t_det = sc.t0 + 3
            wrong = next(s for s in SERVICES if s not in (sc.root, *sc.affected)) if len(SERVICES) > len(sc.affected) + 1 else "search"
            lie = rng.random() < 0.4
            for cfg in ("planner", "llm_halluc", "llm_halluc_nogate"):
                tmp = Path(td) / f"{sid}-{cfg}"
                tmp.mkdir()
                world, inc, symptom = world_for(sc, scores, settings, tmp, t_det)
                llm = None if cfg == "planner" else HallucinatingLLM(inc["id"], sc.root, wrong, lie)
                inv = Investigator(world, llm, max_steps=8)
                if cfg == "llm_halluc_nogate":
                    inv._ground = lambda hyps, ev: (sorted(hyps, key=lambda h: -float(h.get("confidence", 0))), [])
                r = inv.run(inc["id"])
                top = r["hypotheses"][0]["service"] if r["hypotheses"] else None
                rows.append({"scenario": sid, "config": cfg, "fault": sc.fault, "root": sc.root, "symptom": symptom,
                             "top1": top, "top1_ok": int(top == sc.root), "action": r["remediation"]["action"],
                             "expected_action": sc.expected_action,
                             "action_ok": int(r["remediation"]["action"] == sc.expected_action and r["remediation"]["service"] == sc.root),
                             "lie": int(lie and cfg != "planner"), "lie_accepted": int(lie and cfg != "planner" and top == wrong),
                             "grounding": r["grounding"], "tool_calls": r["cost"]["tool_calls"], "seconds": r["cost"]["seconds"]})
                world.store.close()
    elapsed = time.perf_counter() - t0
    noise = noise_reduction(n, seed, settings)
    summary = {"scenarios_fault": len({r["scenario"] for r in rows}), "seed": seed, "elapsed_s": round(elapsed, 1),
               "alert_correlation": noise, "configs": {}}
    for cfg in ("planner", "llm_halluc", "llm_halluc_nogate"):
        rs = [r for r in rows if r["config"] == cfg]
        lies = [r for r in rs if r["lie"]]
        summary["configs"][cfg] = {
            "top1": round(statistics.mean(r["top1_ok"] for r in rs), 3),
            "action_acc": round(statistics.mean(r["action_ok"] for r in rs), 3),
            "grounding_mean": round(statistics.mean(r["grounding"] for r in rs), 3),
            "hallucinated": len(lies),
            "hallucination_accepted": round(statistics.mean(r["lie_accepted"] for r in lies), 3) if lies else None,
            "tool_calls_mean": round(statistics.mean(r["tool_calls"] for r in rs), 2),
            "seconds_p50": round(statistics.median(r["seconds"] for r in rs), 4),
        }
        by_fault = {}
        for f in sorted({r["fault"] for r in rs}):
            fr = [r for r in rs if r["fault"] == f]
            by_fault[f] = {"n": len(fr), "top1": round(statistics.mean(r["top1_ok"] for r in fr), 3),
                           "action_acc": round(statistics.mean(r["action_ok"] for r in fr), 3)}
        summary["configs"][cfg]["by_fault"] = by_fault
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "agent_eval.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (out / "agent_eval_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scenarios", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "results")
    a = ap.parse_args(argv)
    print(json.dumps(run(a.scenarios, a.seed, a.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
