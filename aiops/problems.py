"""Quản lý vấn đề theo ITIL (Problem Management) + kho lỗi đã biết (Known Error Database).

Quản lý sự cố khôi phục dịch vụ NHANH (rollback, restart); quản lý vấn đề tìm và xoá NGUYÊN NHÂN để sự cố không lặp lại.
Không có lớp này, cùng một lỗi gốc được "chữa cháy" mười lần bởi mười người trực khác nhau. Vòng đời:

  ứng viên     sự cố đã đóng (bỏ diễn tập, chưa thuộc vấn đề nào) trong N ngày gom theo dấu vân tay (agent/similar.py:
               service, nguyên nhân gốc, đặc trưng lệch, alert, hành động) — cụm ≥ 3 sự cố giống nhau ≥ 0.6 → đề xuất mở vấn đề,
               xếp theo tổng thời gian gián đoạn (tác động thật, không phải số lần).
  open         đã mở vấn đề, đang điều tra nguyên nhân gốc.
  known_error  đã biết nguyên nhân + có cách xử lý tạm (workaround) → sự cố MỚI khớp dấu vân tay được gắn vào vấn đề và
               bản tin sự cố kèm luôn workaround: người trực không phải điều tra lại từ đầu.
  resolved     đã sửa tận gốc (fix_ref: PR/ticket). Sự cố mới khớp vấn đề đã đóng = TÁI PHÁT → tự mở lại (reopened+1,
               audit problem_regressed): bản sửa không triệt để, hoặc bị đảo ngược bởi thay đổi sau đó.
Dấu vân tay của vấn đề = các token xuất hiện ở ≥ một nửa sự cố trong cụm (bỏ chi tiết ngẫu nhiên của từng lần).
"""

from __future__ import annotations

from collections import Counter

from .agent.similar import fingerprint, similarity

DAY = 86400.0
STATUSES = ("open", "known_error", "resolved")


def _tokens(incidents: list[dict]) -> list[str]:
    cnt = Counter(t for i in incidents for t in fingerprint(i))
    need = max(1, (len(incidents) + 1) // 2)
    return sorted(t for t, n in cnt.items() if n >= need)


def _outage(i: dict) -> float:
    start = i.get("fault_start") or i.get("detected_at")
    return max(0.0, (i.get("resolved_at") or start) - start) if start is not None else 0.0


def candidates(store, now: float, days: int = 30, min_count: int = 3, min_score: float = 0.6) -> list[dict]:
    """Gom cụm tham lam (single-link) trên sự cố đã đóng chưa thuộc vấn đề nào."""
    pool = [i for i in store.list_incidents(status="resolved", since=now - days * DAY, limit=2000, exclude_drills=True)
            if not i.get("problem_id")]
    fps = {i["id"]: fingerprint(i) for i in pool}
    seen, out = set(), []
    for i in sorted(pool, key=lambda x: x["detected_at"]):
        if i["id"] in seen:
            continue
        cluster, frontier = [i], [i]
        seen.add(i["id"])
        while frontier:
            cur = frontier.pop()
            for o in pool:
                if o["id"] not in seen and similarity(fps[cur["id"]], fps[o["id"]]) >= min_score:
                    seen.add(o["id"])
                    cluster.append(o)
                    frontier.append(o)
        if len(cluster) < min_count:
            continue
        toks = _tokens(cluster)
        roots = Counter((c.get("root_causes") or [{}])[0].get("service") or c["service"] for c in cluster)
        out.append({"incident_ids": [c["id"] for c in cluster], "count": len(cluster), "tokens": toks,
                    "root_service": roots.most_common(1)[0][0], "services": sorted({c["service"] for c in cluster}),
                    "first_seen": min(c["detected_at"] for c in cluster), "last_seen": max(c["detected_at"] for c in cluster),
                    "outage_minutes": round(sum(_outage(c) for c in cluster) / 60, 1),
                    "title": f"{roots.most_common(1)[0][0]}: " + ", ".join(t.split(":", 1)[1] for t in toks
                                                                            if t.startswith(("alert:", "feat:")))[:120]})
    out.sort(key=lambda c: -c["outage_minutes"])
    return out


def create(store, incident_ids: list[str], title: str, actor: str, now: float) -> dict:
    incs = [x for x in (store.get_incident(i) for i in incident_ids) if x]
    if not incs:
        raise ValueError("không có sự cố hợp lệ")
    roots = Counter((c.get("root_causes") or [{}])[0].get("service") or c["service"] for c in incs)
    p = store.add_problem(title=title[:200], tokens=_tokens(incs), root_service=roots.most_common(1)[0][0], created_by=actor,
                          created_at=now, updated_at=now)
    for c in incs:
        store.update_incident(c["id"], problem_id=p["id"])
    store.audit(actor, "problem_created", details={"problem": p["code"], "incidents": len(incs)})
    return p


def update(store, problem_id: str, fields: dict, actor: str, now: float) -> dict:
    p = store.get_problem(problem_id)
    if p is None:
        raise KeyError(problem_id)
    ch = {k: (str(v)[:4000] if v is not None else None) for k, v in fields.items() if k in ("title", "workaround", "fix_ref", "owner", "status")}
    st = ch.get("status")
    if st is not None and st not in STATUSES:
        raise ValueError(f"status phải là {'|'.join(STATUSES)}")
    if st == "known_error" and not (ch.get("workaround") or p.get("workaround")):
        raise ValueError("lỗi đã biết phải có cách xử lý tạm (workaround)")
    if st == "resolved" and not (ch.get("fix_ref") or p.get("fix_ref")):
        raise ValueError("đóng vấn đề phải ghi bản sửa tận gốc (fix_ref: PR/ticket)")
    if st == "resolved":
        ch["resolved_at"] = now
    elif st in ("open", "known_error"):
        ch["resolved_at"] = None
    out = store.update_problem(problem_id, **ch, updated_at=now)
    store.audit(actor, "problem_updated", details={"problem": p["code"], "fields": sorted(ch)})
    return out


def match(store, inc: dict, now: float, min_score: float = 0.6) -> dict | None:
    """Sự cố mới (đã có RCA) khớp vấn đề nào? Gắn vào vấn đề; vấn đề đã đóng → mở lại (tái phát)."""
    if inc.get("drill_id") or inc.get("problem_id"):
        return None
    fp = fingerprint(inc)
    best, score = None, 0.0
    for p in store.problems():
        sc = similarity(fp, set(p.get("tokens") or []))
        if sc >= min_score and sc > score:
            best, score = p, sc
    if best is None:
        return None
    store.update_incident(inc["id"], problem_id=best["id"])
    regressed = best["status"] == "resolved"
    if regressed:
        best = store.update_problem(best["id"], status="open", resolved_at=None, reopened=int(best.get("reopened") or 0) + 1,
                                    updated_at=now)
        store.audit("agent", "problem_regressed", inc["id"], details={"problem": best["code"], "score": round(score, 3)})
    else:
        store.update_problem(best["id"], updated_at=now)
        store.audit("agent", "problem_matched", inc["id"], details={"problem": best["code"], "score": round(score, 3)})
    return {**best, "score": round(score, 3), "regressed": regressed}


def note(p: dict) -> str:
    """Dòng chèn vào bản tin sự cố."""
    if p["regressed"]:
        return f"⚠ TÁI PHÁT {p['code']} ({p['title']}) — vấn đề đã đóng với bản sửa {p.get('fix_ref') or '?'}, nay mở lại."
    if p["status"] == "known_error" and p.get("workaround"):
        return f"Lỗi đã biết {p['code']} ({p['title']}). Cách xử lý tạm: {p['workaround']}"
    return f"Thuộc vấn đề đang điều tra {p['code']} ({p['title']})."


def report(store, now: float, days: int = 30) -> dict:
    since = now - days * DAY
    items = []
    for p in store.problems():
        incs = store.problem_incidents(p["id"])
        recent = [i for i in incs if i["detected_at"] >= since]
        items.append({**{k: p.get(k) for k in ("id", "code", "title", "status", "root_service", "workaround", "fix_ref", "owner",
                                                 "reopened", "created_at", "updated_at", "resolved_at")},
                      "incidents": len(incs), "incidents_recent": len(recent),
                      "outage_minutes_recent": round(sum(_outage(i) for i in recent) / 60, 1),
                      "last_seen": max((i["detected_at"] for i in incs), default=None)})
    order = {"open": 0, "known_error": 1, "resolved": 2}
    items.sort(key=lambda x: (order.get(x["status"], 3), -x["outage_minutes_recent"]))
    return {"days": days, "items": items, "candidates": candidates(store, now, days),
            "counts": dict(Counter(p["status"] for p in items))}
