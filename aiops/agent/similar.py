"""Tìm sự cố tương tự đã xử lý (knowledge reuse) — "lần trước bị thế này đã làm gì?".

Dấu vân tay mỗi sự cố = tập token: service:<s>, root:<nguyên nhân gốc top-1>, feat:<đặc trưng lệch của service gốc>,
alert:<tên alert>, action:<hành động runbook>. Độ giống = Jaccard có trọng số (root/service nặng hơn feature/alert).
Chỉ so với sự cố đã đóng; trả kèm hành động đã thực thi và thời gian khắc phục để kỹ sư/tác tử tham khảo.
"""

from __future__ import annotations

WEIGHT = {"root": 3.0, "service": 2.0, "action": 1.5, "feat": 1.0, "alert": 1.0}


def fingerprint(inc: dict) -> set[str]:
    toks = {f"service:{inc.get('service')}"}
    rc = (inc.get("root_causes") or [{}])[0].get("service")
    if rc:
        toks.add(f"root:{rc}")
    anomaly = ((inc.get("context") or {}).get("anomaly") or {})
    for f, _z in (anomaly.get(rc or inc.get("service")) or {}).get("top_features", [])[:3]:
        toks.add(f"feat:{f}")
    for a in inc.get("alerts") or []:
        if a.get("alertname"):
            toks.add(f"alert:{a['alertname']}")
    act = (inc.get("decision") or {}).get("action")
    if act:
        toks.add(f"action:{act}")
    return toks


def _w(tok: str) -> float:
    return WEIGHT.get(tok.split(":", 1)[0], 1.0)


def similarity(a: set[str], b: set[str]) -> float:
    inter = sum(_w(t) for t in a & b)
    union = sum(_w(t) for t in a | b)
    return inter / union if union else 0.0


def find_similar(store, incident_id: str, k: int = 3, min_score: float = 0.3) -> list[dict]:
    inc = store.get_incident(incident_id)
    if inc is None:
        raise KeyError(incident_id)
    fp = fingerprint(inc)
    out = []
    for other in store.list_incidents(status="resolved", limit=500):
        if other["id"] == incident_id:
            continue
        sc = similarity(fp, fingerprint(other))
        if sc < min_score:
            continue
        acts = [{"type": a["type"], "status": a["status"]} for a in store.actions_for(other["id"])]
        start = other.get("fault_start") or other.get("detected_at")
        out.append({"id": other["id"], "title": other.get("title"), "service": other["service"], "score": round(sc, 3),
                    "shared": sorted(fp & fingerprint(other)), "actions": acts,
                    "root_cause": (other.get("root_causes") or [{}])[0].get("service"),
                    "mttr_s": round(other["resolved_at"] - start, 1) if other.get("resolved_at") and start else None})
    out.sort(key=lambda r: -r["score"])
    return out[:k]
