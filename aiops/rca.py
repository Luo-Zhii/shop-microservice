"""RCA: xếp hạng service gốc bằng personalized PageRank trên đồ thị lan truyền (kiểu MicroRCA / CloudRanger).

Đồ thị gọi G: caller → callee. Sự cố lan NGƯỢC chiều gọi (callee hỏng → caller chậm/lỗi), nên để tìm gốc ta cho
"người đi bộ ngẫu nhiên" đi từ triệu chứng THEO chiều gọi về phía phụ thuộc (tức đồ thị lan truyền đảo chiều):
  1. Tập bất thường A = {s : score_s ≥ floor}; ứng viên N = A ∪ callee trực tiếp của A.
  2. Cạnh tiến u→v (caller→callee): w = k_e · (ε + ρ⁺(u,v)) · (ε + score_v), ρ⁺ = max(0, Pearson) giữa chuỗi
     tín hiệu bất thường của u và v trong cửa sổ sự cố; k_e = 1 (sync) hoặc async_weight.
     Cạnh lùi v→u: backward · w (tránh kẹt). Tự vòng u→u: score_u · (1 − max ρ⁺ với callee bất thường)
     — bất thường của u KHÔNG được callee nào giải thích thì u giữ khối lượng (dấu hiệu gốc).
  3. Vector cá nhân hoá ∝ score (chỉ trên A). PageRank α=0.85 → π. Điểm cuối = π_u · score_u, chuẩn hoá tổng 1.
"""

from __future__ import annotations

import networkx as nx
import numpy as np

EPS = 0.05


def _corr(a: np.ndarray | None, b: np.ndarray | None) -> float:
    if a is None or b is None:
        return 1.0
    a, b = np.asarray(a, float), np.asarray(b, float)
    n = min(len(a), len(b))
    if n < 3:
        return 1.0
    a, b = a[-n:], b[-n:]
    if a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    return float(max(0.0, np.corrcoef(a, b)[0, 1]))


def rank_root_causes(graph: nx.DiGraph, scores: dict[str, float], signals: dict[str, np.ndarray] | None = None,
                     top_k: int = 3, alpha: float = 0.85, floor: float = 0.3, backward: float = 0.1,
                     async_weight: float | None = None) -> list[dict]:
    signals = signals or {}
    anomalous = {s for s, v in scores.items() if v >= floor and s in graph}
    if not anomalous:
        anomalous = {s for s, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:3] if s in graph}
    if not anomalous:
        return []
    cand = set(anomalous)
    for s in anomalous:
        cand |= set(graph.successors(s))
    sc = {s: float(scores.get(s, 0.0)) for s in cand}

    H = nx.DiGraph()
    H.add_nodes_from(cand)
    corr_cache: dict[tuple[str, str], float] = {}
    for u in cand:
        best = 0.0
        for v in graph.successors(u):
            if v not in cand:
                continue
            d = graph.edges[u, v]
            k = d.get("weight", 1.0) if async_weight is None or d.get("kind") != "async" else async_weight
            rho = corr_cache.setdefault((u, v), _corr(signals.get(u), signals.get(v)))
            w = k * (EPS + rho) * (EPS + sc[v])
            H.add_edge(u, v, weight=H.get_edge_data(u, v, {}).get("weight", 0) + w)
            H.add_edge(v, u, weight=H.get_edge_data(v, u, {}).get("weight", 0) + backward * w)
            if v in anomalous:
                best = max(best, rho * min(1.0, sc[v] / max(sc[u], 1e-6)))
        H.add_edge(u, u, weight=max(sc[u] * (1 - best), 1e-4))
    total = sum(sc[s] for s in anomalous) or 1.0
    pers = {s: (sc[s] / total if s in anomalous else 1e-6) for s in cand}
    pr = nx.pagerank(H, alpha=alpha, personalization=pers, weight="weight", max_iter=200, tol=1e-8)
    final = {s: pr[s] * (EPS + sc[s]) for s in cand}
    z = sum(final.values()) or 1.0
    ranked = sorted(final, key=lambda s: -final[s])
    out = []
    for i, s in enumerate(ranked[:top_k]):
        callers = [c for c in graph.predecessors(s) if c in anomalous]
        callees = [c for c in graph.successors(s) if c in anomalous]
        out.append({
            "rank": i + 1,
            "service": s,
            "score": round(final[s] / z, 4),
            "anomaly_score": round(sc[s], 4),
            "evidence": {
                "anomalous_callers": sorted(callers),
                "anomalous_callees": sorted(callees),
                "corr_with_callers": {c: round(corr_cache.get((c, s), _corr(signals.get(c), signals.get(s))), 3)
                                      for c in sorted(callers)},
                "unexplained_by_callees": not callees,
            },
        })
    return out


def rank_by_score(scores: dict[str, float], top_k: int = 3) -> list[str]:
    """Baseline: service có điểm bất thường cao nhất là gốc."""
    return [s for s, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:top_k]]


def rank_plain_pagerank(graph: nx.DiGraph, scores: dict[str, float], top_k: int = 3, floor: float = 0.3) -> list[str]:
    """Baseline: PageRank thường (không trọng số tương quan/điểm) trên đồ thị con bất thường."""
    nodes = [s for s, v in scores.items() if v >= floor and s in graph] or rank_by_score(scores, 3)
    sub = graph.subgraph(nodes).copy()
    if sub.number_of_edges() == 0:
        return rank_by_score({s: scores[s] for s in nodes}, top_k)
    pr = nx.pagerank(sub, alpha=0.85)
    return [s for s, _ in sorted(pr.items(), key=lambda kv: -kv[1])[:top_k]]
