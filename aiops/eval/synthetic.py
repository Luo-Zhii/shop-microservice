"""Đánh giá trên dữ liệu tổng hợp: IsolationForest / robust-z / ensemble AIOps vs ngưỡng tĩnh, MTTD, RCA top-k,
độ đúng hành động runbook và MTTR ước lượng.

    python -m aiops.eval.synthetic --scenarios 30 --seed 42 [--out aiops/eval/results]

Công thức (xem README): precision = TP/(TP+FP), recall = TP/(TP+FN), F1 = 2PR/(P+R) trên từng điểm
(kịch bản × service × bước, chỉ phần sau huấn luyện); PA-F1 = F1 sau "point-adjust" (một điểm đúng trong đoạn
bất thường → cả đoạn tính đúng); event recall = tỉ lệ kịch bản lỗi có ≥1 cảnh báo trên service bị ảnh hưởng
trong [t0, t1+grace]; MTTD = t_cảnh_báo_đầu − t0; RCA top-k = tỉ lệ kịch bản phát hiện được mà gốc thật nằm trong k
ứng viên đầu.
"""

from __future__ import annotations

import argparse
import csv
import statistics
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from ..agent.runbook import choose_action
from ..collectors.service_graph import static_graph
from ..config import load_settings
from ..detection.metrics import persist, score_service
from ..rca import rank_by_score, rank_plain_pagerank, rank_root_causes
from .simulator import SERVICES, simulate

STEP = 30
TRAIN = 120
T = 240
GRACE = 4
METHODS = ("static", "zscore", "iforest", "aiops")

# Tham số mô hình MTTR (giả định, ghi rõ trong báo cáo)
MTTR = dict(notify_s=15, approval_s=120, exec_s={"rollback": 90, "scale_up": 60, "restart": 45},
            manual_diag_s=900, user_report_s=600)


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def point_adjust(pred: np.ndarray, lab: np.ndarray) -> np.ndarray:
    pred = pred.copy()
    i = 0
    n = len(lab)
    while i < n:
        if lab[i]:
            j = i
            while j < n and lab[j]:
                j += 1
            if pred[i:j].any():
                pred[i:j] = True
            i = j
        else:
            i += 1
    return pred


def episodes(flags: np.ndarray) -> list[int]:
    """chỉ số bắt đầu của mỗi đợt cảnh báo liên tục."""
    f = np.asarray(flags, dtype=bool)
    return [int(i) for i in np.nonzero(f & ~np.concatenate([[False], f[:-1]]))[0]]


def _simulate_and_score(args):
    """Một kịch bản: sinh dữ liệu (seed riêng → kết quả không phụ thuộc số tiến trình) + chấm điểm mọi service."""
    sid, sc_seed, base_seed = args
    rng = np.random.default_rng(sc_seed)
    # cân bằng loại lỗi: 4 loại lỗi xoay vòng, cứ 6 kịch bản có 1 kịch bản tăng tải lành tính
    if sid % 6 == 5:
        sc = simulate(sid, rng, T, TRAIN, kind="surge")
    else:
        fault = ("latency", "error", "cpu", "pod_kill")[(sid - sid // 6) % 4]
        sc = simulate(sid, rng, T, TRAIN, kind="fault", fault=fault)
    scores = {s: score_service(s, sc.raw[s], slice(0, TRAIN), random_state=base_seed + sid) for s in SERVICES}
    return sc, scores


def run(n: int, seed: int, out: Path, threshold: float, persistence: int, quiet: bool = False, jobs: int = 1) -> dict:
    t_start = time.perf_counter()
    settings = load_settings()
    graph = static_graph(settings.raw["graph"], settings.services)
    rng = np.random.default_rng(seed)
    pooled = {m: [0, 0, 0] for m in METHODS}
    pooled_pa = {m: [0, 0, 0] for m in METHODS}
    fa_eps = {m: 0 for m in METHODS}
    rows = []
    rca_rows = []
    per_fault = defaultdict(lambda: defaultdict(list))
    seeds = rng.integers(0, 2**31 - 1, size=n)
    jobs_args = [(sid, int(seeds[sid]), seed) for sid in range(n)]
    if jobs > 1:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=jobs) as ex:
            results = list(ex.map(_simulate_and_score, jobs_args))
    else:
        results = [_simulate_and_score(a) for a in jobs_args]
    for sid, (sc, scores) in enumerate(results):
        flags = {}
        for s, ss in scores.items():
            flags[s] = {
                "static": persist(ss.static, persistence),
                "zscore": persist(ss.zscore >= threshold, persistence),
                "iforest": persist(ss.iforest >= threshold, persistence),
                "aiops": persist(ss.combined >= threshold, persistence),
            }
        ev = slice(TRAIN, T)
        row = {"scenario": sid, "kind": sc.kind, "fault": sc.fault or "-", "root": sc.root or "-",
               "t0": sc.t0, "duration_steps": max(0, sc.t1 - sc.t0), "affected": len(sc.affected)}
        for m in METHODS:
            det_t = None
            for s in SERVICES:
                pred, lab = flags[s][m][ev], sc.labels[s][ev]
                pooled[m][0] += int((pred & lab).sum())
                pooled[m][1] += int((pred & ~lab).sum())
                pooled[m][2] += int((~pred & lab).sum())
                pa = point_adjust(pred, lab)
                pooled_pa[m][0] += int((pa & lab).sum())
                pooled_pa[m][1] += int((pa & ~lab).sum())
                pooled_pa[m][2] += int((~pa & lab).sum())
                win = np.zeros(T, dtype=bool)
                if sc.kind == "fault" and s in sc.affected:
                    win[sc.t0:min(T, sc.t1 + GRACE)] = True
                for e in episodes(flags[s][m]):
                    if e < TRAIN:
                        continue
                    if win[e]:
                        det_t = e if det_t is None else min(det_t, e)
                    else:
                        fa_eps[m] += 1
            row[f"detected_{m}"] = int(det_t is not None) if sc.kind == "fault" else "-"
            row[f"mttd_s_{m}"] = (det_t - sc.t0 + 1) * STEP if det_t is not None else ""
            if sc.kind == "fault":
                per_fault[sc.fault][f"det_{m}"].append(det_t is not None)
                if det_t is not None:
                    per_fault[sc.fault][f"mttd_{m}"].append((det_t - sc.t0 + 1) * STEP)
            if m == "aiops":
                row["_det"] = det_t
        # ---------------- RCA + runbook (chỉ kịch bản lỗi) ----------------
        if sc.kind == "fault":
            for variant, t_det in (("detected", row["_det"]), ("oracle", sc.t0 + 3)):
                if t_det is None:
                    continue
                t_rca = min(T - 1, t_det + 4)
                lo = max(TRAIN, t_det - 20)
                sc_now = {s: float(scores[s].combined[max(lo, t_det - 2):t_rca + 1].max()) for s in SERVICES}
                sig = {s: scores[s].zmax[lo:t_rca + 1] for s in SERVICES}
                ours = [r["service"] for r in rank_root_causes(graph, sc_now, sig, top_k=3,
                                                                 async_weight=settings.raw["graph"].get("async_weight"))]
                base_score = rank_by_score(sc_now, 3)
                base_pr = rank_plain_pagerank(graph, sc_now, 3)
                rr = {"scenario": sid, "variant": variant, "fault": sc.fault, "root": sc.root,
                      "ppr_top": ",".join(ours), "ppr_top1": int(ours[:1] == [sc.root]), "ppr_top3": int(sc.root in ours),
                      "maxscore_top1": int(base_score[:1] == [sc.root]), "maxscore_top3": int(sc.root in base_score),
                      "pagerank_top1": int(base_pr[:1] == [sc.root]), "pagerank_top3": int(sc.root in base_pr)}
                if variant == "detected":
                    target = ours[0] if ours else sc.root
                    zr = scores[target].z[t_det]
                    symptoms = [f for f, v in zip(("p95", "err", "rps", "cpu", "mem", "dlq"), zr) if v >= 3.0]
                    ctx = dict(sc.context if target == sc.root else {"recent_deploy": False, "crashloop": False, "pod_restarted": False})
                    ctx.update(service=target, symptoms=symptoms, score=sc_now.get(target, 0))
                    decision = choose_action(settings.runbook, ctx)
                    rr.update(action=decision["action"], expected_action=sc.expected_action,
                              action_ok=int(decision["action"] == sc.expected_action and target == sc.root))
                    row.update(rca_top1=ours[0] if ours else "", rca_ok_top1=rr["ppr_top1"], rca_ok_top3=rr["ppr_top3"],
                               action=decision["action"], expected_action=sc.expected_action, action_ok=rr["action_ok"])
                    row["mttr_s_aiops"], row["mttr_s_manual"] = mttr_model(sc, row, decision, rr["action_ok"])
                rca_rows.append(rr)
        row.pop("_det", None)
        rows.append(row)
        if not quiet:
            print(f"  kịch bản {sid:3d} {sc.kind:5s} {row['fault']:8s} gốc={row['root']:13s} "
                  f"aiops={row.get('detected_aiops')} static={row.get('detected_static')} rca={row.get('rca_top1', '-')}")
    elapsed = time.perf_counter() - t_start
    summary = summarize(rows, rca_rows, pooled, pooled_pa, fa_eps, per_fault, n, elapsed, seed, threshold, persistence)
    write_outputs(out, rows, rca_rows, summary)
    return summary


def mttr_model(sc, row, decision, action_ok) -> tuple[float | str, float | str]:
    """MTTR (s) ước lượng tính từ t0. AIOps: phát hiện → thông báo → duyệt → thực thi; sai thì như thủ công.
    Thủ công (baseline): cảnh báo tĩnh (hoặc người dùng báo sau user_report_s) → chẩn đoán/xử lý manual_diag_s."""
    fault_end = (sc.t1 - sc.t0) * STEP
    det_ai = row.get("mttd_s_aiops")
    det_st = row.get("mttd_s_static")
    if det_ai == "":
        aiops = min(fault_end, MTTR["user_report_s"] + MTTR["manual_diag_s"])
    elif decision["action"] in MTTR["exec_s"] and action_ok:
        wait = MTTR["approval_s"] if decision["approval"] == "required" else 0
        aiops = min(fault_end, det_ai + MTTR["notify_s"] + wait + MTTR["exec_s"][decision["action"]])
    else:
        aiops = min(fault_end, det_ai + MTTR["manual_diag_s"])
    det_manual = det_st if det_st != "" else MTTR["user_report_s"]
    manual = min(fault_end, det_manual + MTTR["manual_diag_s"])
    return aiops, manual


def _mean(xs):
    return round(statistics.mean(xs), 1) if xs else None


def _median(xs):
    return round(statistics.median(xs), 1) if xs else None


def summarize(rows, rca_rows, pooled, pooled_pa, fa_eps, per_fault, n, elapsed, seed, threshold, persistence):
    faults = [r for r in rows if r["kind"] == "fault"]
    surges = [r for r in rows if r["kind"] == "surge"]
    hours = n * (T - TRAIN) * STEP / 3600
    methods = {}
    for m in METHODS:
        p, r, f = prf(*pooled[m])
        _, _, fpa = prf(*pooled_pa[m])
        mttd = [x[f"mttd_s_{m}"] for x in faults if x[f"mttd_s_{m}"] != ""]
        methods[m] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3), "pa_f1": round(fpa, 3),
                      "event_recall": round(sum(x[f"detected_{m}"] for x in faults) / max(1, len(faults)), 3),
                      "mttd_mean_s": _mean(mttd), "mttd_median_s": _median(mttd),
                      "false_alarms_per_hour": round(fa_eps[m] / hours, 2)}
    rca = {}
    for variant in ("detected", "oracle"):
        rs = [r for r in rca_rows if r["variant"] == variant]
        rca[variant] = {"n": len(rs)}
        for algo in ("ppr", "maxscore", "pagerank"):
            for k in ("top1", "top3"):
                rca[variant][f"{algo}_{k}"] = round(sum(r[f"{algo}_{k}"] for r in rs) / max(1, len(rs)), 3)
    by_fault = {}
    for fault, d in sorted(per_fault.items()):
        rs = [r for r in rca_rows if r["variant"] == "detected" and r["fault"] == fault]
        by_fault[fault] = {"n": len(d["det_aiops"]),
                           **{f"recall_{m}": round(sum(d[f'det_{m}']) / len(d[f'det_{m}']), 2) for m in METHODS},
                           **{f"mttd_{m}": _median(d[f"mttd_{m}"]) for m in ("static", "aiops")},
                           "rca_top1": round(sum(r["ppr_top1"] for r in rs) / max(1, len(rs)), 2),
                           "rca_top3": round(sum(r["ppr_top3"] for r in rs) / max(1, len(rs)), 2)}
    acted = [r for r in rca_rows if r["variant"] == "detected"]
    mttr_ai = [r["mttr_s_aiops"] for r in faults if "mttr_s_aiops" in r]
    mttr_man = [r["mttr_s_manual"] for r in faults if "mttr_s_manual" in r]
    return {"scenarios": n, "fault_scenarios": len(faults), "surge_scenarios": len(surges), "seed": seed,
            "threshold": threshold, "persistence": persistence, "elapsed_s": round(elapsed, 1),
            "methods": methods, "rca": rca, "by_fault": by_fault,
            "action_accuracy": round(sum(r["action_ok"] for r in acted) / max(1, len(acted)), 3),
            "mttr": {"aiops_mean_s": _mean(mttr_ai), "manual_mean_s": _mean(mttr_man),
                     "aiops_median_s": _median(mttr_ai), "manual_median_s": _median(mttr_man)}}


def write_outputs(out: Path, rows, rca_rows, s):
    out.mkdir(parents=True, exist_ok=True)
    keys = sorted({k for r in rows for k in r}, key=lambda k: list(rows[0]).index(k) if k in rows[0] else 99)
    with open(out / "synthetic_scenarios.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    with open(out / "synthetic_rca.csv", "w", newline="", encoding="utf-8") as f:
        keys = sorted({k for r in rca_rows for k in r}, key=lambda k: list(rca_rows[0]).index(k) if k in rca_rows[0] else 99)
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(rca_rows)
    with open(out / "synthetic_summary.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["method", "precision", "recall", "f1", "pa_f1", "event_recall", "mttd_mean_s", "mttd_median_s",
                    "false_alarms_per_hour"])
        for m, v in s["methods"].items():
            w.writerow([m] + [v[k] for k in ("precision", "recall", "f1", "pa_f1", "event_recall", "mttd_mean_s",
                                             "mttd_median_s", "false_alarms_per_hour")])
    (out / "synthetic_report.md").write_text(render_md(s), encoding="utf-8")


NAMES = {"static": "Ngưỡng tĩnh (err>5% ∨ p95>1s)", "zscore": "Robust z-score (median/MAD)",
         "iforest": "IsolationForest", "aiops": "AIOps ensemble (IF + z)"}


def render_md(s) -> str:
    L = ["# Đánh giá AIOps trên dữ liệu tổng hợp ShopNow", "",
         f"- Kịch bản: **{s['scenarios']}** ({s['fault_scenarios']} có lỗi tiêm, {s['surge_scenarios']} tăng tải lành tính), "
         f"15 service × 240 bước × 30s (60 phút huấn luyện + 60 phút đánh giá), seed={s['seed']}",
         f"- Ngưỡng điểm = {s['threshold']}, lọc bền vững {s['persistence']} bước liên tiếp; thời gian chạy {s['elapsed_s']} s", "",
         "## 1. Phát hiện bất thường", "",
         "| Phương pháp | Precision | Recall | F1 | PA-F1 | Event recall | MTTD TB (s) | MTTD trung vị (s) | Báo động giả / giờ |",
         "|---|---|---|---|---|---|---|---|---|"]
    for m, v in s["methods"].items():
        L.append(f"| {NAMES[m]} | {v['precision']} | {v['recall']} | {v['f1']} | {v['pa_f1']} | {v['event_recall']} | "
                 f"{v['mttd_mean_s']} | {v['mttd_median_s']} | {v['false_alarms_per_hour']} |")
    L += ["", "Point-wise trên (kịch bản × service × bước) sau huấn luyện; nhãn dương = service bị ảnh hưởng đáng kể "
          "trong cửa sổ lỗi. Báo động giả = đợt cảnh báo bắt đầu ngoài (service bị ảnh hưởng × [t0, t1+2 phút]), "
          "chia cho tổng giờ đánh giá của cả hệ thống.", "",
          "## 2. Theo loại lỗi (event recall / MTTD trung vị / RCA)", "",
          "| Lỗi | n | Recall tĩnh | Recall z | Recall IF | Recall AIOps | MTTD tĩnh (s) | MTTD AIOps (s) | RCA top-1 | RCA top-3 |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for f, v in s["by_fault"].items():
        L.append(f"| {f} | {v['n']} | {v['recall_static']} | {v['recall_zscore']} | {v['recall_iforest']} | "
                 f"{v['recall_aiops']} | {v['mttd_static']} | {v['mttd_aiops']} | {v['rca_top1']} | {v['rca_top3']} |")
    r = s["rca"]
    L += ["", "## 3. Phân tích nguyên nhân gốc (RCA)", "",
          "| Thuật toán | Top-1 (sau phát hiện) | Top-3 (sau phát hiện) | Top-1 (oracle t0+90s) | Top-3 (oracle) |",
          "|---|---|---|---|---|"]
    for algo, name in (("ppr", "Personalized PageRank + tương quan (đề xuất)"), ("maxscore", "Điểm bất thường lớn nhất"),
                       ("pagerank", "PageRank thường trên đồ thị con")):
        L.append(f"| {name} | {r['detected'][f'{algo}_top1']} | {r['detected'][f'{algo}_top3']} | "
                 f"{r['oracle'][f'{algo}_top1']} | {r['oracle'][f'{algo}_top3']} |")
    L += ["", f"Số kịch bản RCA: sau phát hiện = {r['detected']['n']}, oracle = {r['oracle']['n']}. "
          "RCA chạy 2 phút sau cảnh báo đầu tiên, cửa sổ tín hiệu ≤ 10 phút trước đó.", "",
          "## 4. Tác tử: chọn hành động & MTTR ước lượng", "",
          f"- Độ đúng hành động (đúng service gốc **và** đúng loại hành động theo runbook): **{s['action_accuracy']}**",
          f"- MTTR TB: AIOps **{s['mttr']['aiops_mean_s']} s** (trung vị {s['mttr']['aiops_median_s']}) vs thủ công "
          f"**{s['mttr']['manual_mean_s']} s** (trung vị {s['mttr']['manual_median_s']})", "",
          f"Giả định MTTR: gửi thông báo {MTTR['notify_s']}s, chờ duyệt {MTTR['approval_s']}s, thực thi "
          f"rollback/scale/restart = {MTTR['exec_s']['rollback']}/{MTTR['exec_s']['scale_up']}/{MTTR['exec_s']['restart']}s; "
          f"chẩn đoán thủ công {MTTR['manual_diag_s']}s; không có cảnh báo → người dùng báo sau {MTTR['user_report_s']}s; "
          "MTTR bị chặn trên bởi thời điểm lỗi tự hết. Đây là mô hình phân tích, KHÔNG phải đo thật — số đo thật lấy từ "
          "`python -m aiops.eval.chaos_runner`.", "",
          "File: `synthetic_summary.csv`, `synthetic_scenarios.csv`, `synthetic_rca.csv`."]
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Đánh giá AIOps trên dữ liệu tổng hợp")
    ap.add_argument("--scenarios", type=int, default=30)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--threshold", type=float, default=0.6)
    ap.add_argument("--persistence", type=int, default=2)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "results"))
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--jobs", type=int, default=2, help="số tiến trình song song (kết quả không phụ thuộc giá trị này)")
    a = ap.parse_args(argv)
    s = run(a.scenarios, a.seed, Path(a.out), a.threshold, a.persistence, a.quiet, a.jobs)
    print(render_md(s))


if __name__ == "__main__":
    main()
