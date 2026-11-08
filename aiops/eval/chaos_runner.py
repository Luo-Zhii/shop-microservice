"""Runner thí nghiệm thật: tiêm lỗi Chaos Mesh → đo MTTD/MTTR/RCA top-k từ API AIOps.

    python -m aiops.eval.chaos_runner --experiments aiops/eval/experiments.yaml --aiops-url http://aiops:8120
    python -m aiops.eval.chaos_runner --dry-run          # không đụng cluster: chạy app AIOps trong tiến trình,
                                                          # giả lập alert để kiểm tra trọn luồng
Mỗi thí nghiệm: ghi t_inject → `kubectl apply -f` → poll GET /incidents?since= tới khi có sự cố → báo mốc lỗi thật
(POST /incidents/{id}/fault-start) → để lỗi chạy observe_seconds → `kubectl delete -f` → poll tới khi sự cố
resolved → nghỉ cooldown. MTTD = detected_at − t_inject; MTTR = resolved_at − t_inject;
TTM = mitigated_at − t_inject (khi tác tử thực thi hành động); RCA top-k so với expected_root_cause.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import yaml

from ..util import iso, parse_ts

log = logging.getLogger("aiops.chaos")
HERE = Path(__file__).resolve().parent


@dataclass
class Experiment:
    name: str
    manifest: Path
    expected_root: str | None
    fault_type: str | None
    namespace: str
    observe_s: int
    detect_timeout_s: int
    recover_timeout_s: int
    cooldown_s: int
    poll_s: int


def load_experiments(path: Path) -> list[Experiment]:
    cfg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    d = cfg.get("defaults") or {}
    out = []
    for e in cfg.get("experiments") or []:
        mf = (path.parent / e["manifest"]).resolve()
        meta: dict = {}
        if mf.exists():
            docs = [x for x in yaml.safe_load_all(mf.read_text(encoding="utf-8")) if x]
            meta = (docs[0].get("metadata") or {}) if docs else {}
        ann, labels = meta.get("annotations") or {}, meta.get("labels") or {}
        g = lambda k, default=None: e.get(k, d.get(k, default))  # noqa: E731
        out.append(Experiment(
            name=e.get("name") or meta.get("name") or mf.stem, manifest=mf,
            expected_root=e.get("expected_root_cause") or ann.get("aiops.shopnow.io/expected-root-cause"),
            fault_type=e.get("fault_type") or labels.get("aiops.shopnow.io/fault-type"),
            namespace=g("namespace", "shopnow"), observe_s=int(g("observe_seconds", 300)),
            detect_timeout_s=int(g("detect_timeout_seconds", 600)), recover_timeout_s=int(g("recover_timeout_seconds", 900)),
            cooldown_s=int(g("cooldown_seconds", 300)), poll_s=int(g("poll_seconds", 10))))
    return out


# ---------------------------------------------------------------- client AIOps
class AiopsHttp:
    def __init__(self, base_url: str, token: str | None = None):
        import httpx

        self.c = httpx.Client(base_url=base_url.rstrip("/"), timeout=15,
                              headers={"authorization": f"Bearer {token}"} if token else None)

    def incidents(self, since: float) -> list[dict]:
        return self.c.get("/incidents", params={"since": iso(since), "limit": 50}).json()["items"]

    def incident(self, id_: str) -> dict:
        return self.c.get(f"/incidents/{id_}").json()

    def set_fault_start(self, id_: str, ts: float) -> None:
        self.c.post(f"/incidents/{id_}/fault-start", json={"fault_start": iso(ts), "source": "chaos"})

    def feedback(self, id_: str, root: str) -> None:
        self.c.post(f"/incidents/{id_}/feedback", json={"root_cause": root, "source": "chaos"})


class Kubectl:
    def __init__(self, dry_run: bool, kubectl: str = "kubectl", context: str | None = None):
        self.dry_run, self.bin, self.context = dry_run, kubectl, context
        self.log: list[str] = []

    def run(self, verb: str, manifest: Path) -> None:
        cmd = [self.bin] + (["--context", self.context] if self.context else []) + [verb, "-f", str(manifest)]
        if verb == "delete":
            cmd.append("--ignore-not-found")
        self.log.append(" ".join(cmd))
        if self.dry_run:
            log.info("[dry-run] %s", " ".join(cmd))
            return
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(f"{' '.join(cmd)} lỗi: {r.stderr.strip()[:300]}")


class DryRunWorld:
    """Dry-run: app AIOps thật chạy trong tiến trình (SQLite tạm, DRY_RUN executor, notifier log),
    'cluster' giả bắn alert Alertmanager cho service gốc mong đợi sau `detect_delay` giây ảo."""

    def __init__(self, tmpdir: Path, detect_delay: float = 45.0):
        import os

        os.environ.setdefault("NOTIFY_ENABLED", "false")
        from fastapi.testclient import TestClient

        from ..agent.kube import StaticInspector
        from ..agent.notifier import Notifier
        from ..api import create_app
        from ..config import load_settings
        from ..llm import NoneProvider

        s = load_settings()
        s.db_url = f"sqlite:///{tmpdir / 'dryrun.db'}"
        s.audit_log = str(tmpdir / "dryrun-audit.jsonl")
        s.detector_enabled, s.dry_run, s.prometheus_url = False, True, ""
        s.approval_secret = "dry-run"
        self.now = time.time()
        self.inspector = StaticInspector()
        app = create_app(s, prom=None, loki=None, inspector=self.inspector, notifier=Notifier(enabled=False),
                         llm=NoneProvider(), clock=lambda: self.now)
        self.client = TestClient(app)
        self.detect_delay = detect_delay
        self.active: dict[str, dict] = {}

    # API giống AiopsHttp
    def incidents(self, since):
        return self.client.get("/incidents", params={"since": iso(since)}).json()["items"]

    def incident(self, id_):
        return self.client.get(f"/incidents/{id_}").json()

    def set_fault_start(self, id_, ts):
        self.client.post(f"/incidents/{id_}/fault-start", json={"fault_start": iso(ts), "source": "chaos"})

    def feedback(self, id_, root):
        self.client.post(f"/incidents/{id_}/feedback", json={"root_cause": root, "source": "chaos"})

    def sleep(self, s: float):
        self.now += s

    def inject(self, exp: Experiment, t_inject: float):
        svc = exp.expected_root or "api-gateway"
        alert = {"labels": {"alertname": "AIOpsAnomaly", "service": svc, "namespace": exp.namespace,
                            "severity": "warning", "source": "aiops"},
                 "annotations": {"summary": f"[dry-run] {exp.name}"}, "startsAt": iso(t_inject + self.detect_delay),
                 "fingerprint": f"dry-{exp.name}"}
        self.active[exp.name] = alert
        self.now = t_inject + self.detect_delay
        self.client.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [dict(alert, status="firing")]})

    def remove(self, exp: Experiment):
        alert = self.active.pop(exp.name, None)
        if alert:
            self.now += 60
            self.client.post("/webhooks/alertmanager", json={"status": "resolved", "alerts": [
                dict(alert, status="resolved", endsAt=iso(self.now))]})


# ---------------------------------------------------------------- chạy
def run_one(exp: Experiment, api, kube: Kubectl, sleep, clock, dry: DryRunWorld | None) -> dict:
    row = {"experiment": exp.name, "fault_type": exp.fault_type, "expected_root": exp.expected_root,
           "manifest": str(exp.manifest), "mode": "dry-run" if dry else "live"}
    if not exp.manifest.exists() and not dry:
        row["error"] = "không thấy manifest"
        return row
    t_inject = clock()
    row["t_inject"] = iso(t_inject)
    kube.run("apply", exp.manifest)
    if dry:
        dry.inject(exp, t_inject)
    inc = None
    deadline = t_inject + exp.detect_timeout_s
    while clock() <= deadline:
        cands = [i for i in api.incidents(t_inject - 60) if (parse_ts(i.get("detected_at")) or 0) >= t_inject - 30]
        if cands:
            inc = min(cands, key=lambda i: parse_ts(i["detected_at"]))
            break
        sleep(exp.poll_s)
    if inc:
        api.set_fault_start(inc["id"], t_inject)
        det = parse_ts(inc["detected_at"])
        row.update(incident_id=inc["id"], detected_service=inc.get("service"), alert_source=inc.get("source"),
                   detected_at=inc["detected_at"], mttd_s=round(det - t_inject, 1))
    else:
        row["detected"] = False
    # để lỗi chạy rồi gỡ
    remaining = exp.observe_s - (clock() - t_inject)
    if remaining > 0:
        sleep(remaining)
    kube.run("delete", exp.manifest)
    if dry:
        dry.remove(exp)
    row["t_remove"] = iso(clock())
    if inc:
        deadline = clock() + exp.recover_timeout_s
        detail = api.incident(inc["id"])
        while detail.get("status") != "resolved" and clock() <= deadline:
            sleep(exp.poll_s)
            detail = api.incident(inc["id"])
        if exp.expected_root:
            api.feedback(inc["id"], exp.expected_root)
        rcs = [r["service"] for r in detail.get("root_causes") or []]
        acts = detail.get("actions") or []
        row.update(detected=True, rca_top=",".join(rcs),
                   rca_top1=int(bool(rcs) and rcs[0] == exp.expected_root),
                   rca_top3=int(exp.expected_root in rcs[:3]),
                   action=acts[0]["type"] if acts else "notify", action_status=acts[0]["status"] if acts else "-",
                   status=detail.get("status"))
        for k_out, k_in in (("ttm_s", "mitigated_at"), ("mttr_s", "resolved_at"), ("tta_s", "acknowledged_at")):
            ts = parse_ts(detail.get(k_in))
            row[k_out] = round(ts - t_inject, 1) if ts else ""
    sleep(exp.cooldown_s)
    return row


def summarize(rows: list[dict]) -> dict:
    det = [r for r in rows if r.get("detected")]
    vals = lambda k: [r[k] for r in det if r.get(k) not in ("", None)]  # noqa: E731
    stat = lambda xs: {"mean": round(statistics.mean(xs), 1), "median": round(statistics.median(xs), 1)} if xs else None  # noqa: E731
    return {"n": len(rows), "detected": len(det), "detection_rate": round(len(det) / max(1, len(rows)), 3),
            "mttd_s": stat(vals("mttd_s")), "mttr_s": stat(vals("mttr_s")), "ttm_s": stat(vals("ttm_s")),
            "rca_top1": round(sum(r.get("rca_top1", 0) for r in det) / max(1, len(det)), 3),
            "rca_top3": round(sum(r.get("rca_top3", 0) for r in det) / max(1, len(det)), 3)}


def write(out: Path, rows: list[dict], s: dict, dry: bool) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    stem = "chaos_dryrun" if dry else "chaos_runs"
    keys = []
    for r in rows:
        keys += [k for k in r if k not in keys]
    with open(out / f"{stem}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    L = [f"# Thí nghiệm Chaos Mesh {'(DRY-RUN — số liệu giả lập, chỉ kiểm tra luồng)' if dry else '(thật)'}", "",
         f"- Số thí nghiệm: {s['n']}, phát hiện: {s['detected']} ({s['detection_rate']})",
         f"- MTTD: {s['mttd_s']}", f"- MTTR: {s['mttr_s']}", f"- Thời gian tới khi khắc phục (TTM): {s['ttm_s']}",
         f"- RCA top-1: {s['rca_top1']}, top-3: {s['rca_top3']}", "",
         "| Thí nghiệm | Lỗi | Gốc mong đợi | Phát hiện | Nguồn alert | MTTD (s) | RCA top-3 | Top-1 đúng | Hành động | MTTR (s) |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        L.append(f"| {r['experiment']} | {r.get('fault_type')} | {r.get('expected_root')} | {'✓' if r.get('detected') else '✗'} | "
                 f"{r.get('alert_source', '-')} | {r.get('mttd_s', '-')} | {r.get('rca_top', '-')} | {r.get('rca_top1', '-')} | "
                 f"{r.get('action', '-')}/{r.get('action_status', '-')} | {r.get('mttr_s', '-')} |")
    (out / f"{stem}.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    return out / f"{stem}.md"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m aiops.eval.chaos_runner")
    ap.add_argument("--experiments", default=str(HERE / "experiments.yaml"))
    ap.add_argument("--aiops-url", default="http://localhost:8120")
    ap.add_argument("--token", help="Bearer token nếu API AIOps yêu cầu")
    ap.add_argument("--kube-context")
    ap.add_argument("--only", help="chỉ chạy thí nghiệm có tên chứa chuỗi này")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default=str(HERE / "results"))
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    exps = load_experiments(Path(a.experiments))
    if a.only:
        exps = [e for e in exps if a.only in e.name]
    kube = Kubectl(a.dry_run, context=a.kube_context)
    if a.dry_run:
        import tempfile

        tmp = Path(tempfile.mkdtemp(prefix="aiops-dry-"))
        world = DryRunWorld(tmp)
        api, sleep, clock = world, world.sleep, lambda: world.now
    else:
        world, api, sleep, clock = None, AiopsHttp(a.aiops_url, a.token), time.sleep, time.time
    rows = []
    for e in exps:
        log.info("▶ %s (gốc mong đợi: %s)", e.name, e.expected_root)
        try:
            rows.append(run_one(e, api, kube, sleep, clock, world))
        except Exception as ex:  # noqa: BLE001 - luôn cố gỡ lỗi đã tiêm
            log.exception("thí nghiệm %s lỗi: %s", e.name, ex)
            try:
                kube.run("delete", e.manifest)
            except Exception:  # noqa: BLE001
                pass
            rows.append({"experiment": e.name, "error": str(ex)})
    s = summarize(rows)
    path = write(Path(a.out), rows, s, a.dry_run)
    print(json.dumps(s, ensure_ascii=False, indent=2))
    print(f"báo cáo: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
