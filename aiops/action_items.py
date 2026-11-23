"""Việc cần làm sau sự cố (postmortem action items) — thứ hay bị bỏ quên nhất của quy trình sự cố.

Postmortem viết xong, "bài học" nằm trong wiki, ba tháng sau sự cố lặp lại vì việc chưa ai làm. Ở đây mỗi việc có:
người phụ trách, mức ưu tiên → hạn chót mặc định (P1 7 ngày, P2 30 ngày, P3 90 ngày), trạng thái open → done (BẮT BUỘC dẫn
PR/ticket) | wontfix (BẮT BUỘC lý do). Đo tỉ lệ đóng ĐÚNG HẠN và thời gian đóng — chỉ số "học từ sự cố" mà MTTR không thấy.
Việc có thể gắn vào vấn đề (problems.py): đóng vấn đề mà còn việc mở là dấu hiệu sửa chưa triệt để.
"""

from __future__ import annotations

import statistics

DAY = 86400.0
DUE_DAYS = {"P1": 7, "P2": 30, "P3": 90}
STATUSES = ("open", "done", "wontfix")


def create(store, incident_id: str, body: dict, actor: str, now: float) -> dict:
    title = str(body.get("title") or "").strip()
    prio = str(body.get("priority") or "P2")
    if not title:
        raise ValueError("cần tiêu đề việc")
    if prio not in DUE_DAYS:
        raise ValueError("priority phải là P1|P2|P3")
    if store.get_incident(incident_id) is None:
        raise KeyError(incident_id)
    due = float(body["due_at"]) if body.get("due_at") else now + DUE_DAYS[prio] * DAY
    inc = store.get_incident(incident_id)
    it = store.add_action_item(incident_id=incident_id, problem_id=inc.get("problem_id"), title=title[:300],
                               owner=(str(body.get("owner") or "").strip()[:120] or None), priority=prio, due_at=due,
                               status="open", created_by=actor, created_at=now)
    store.audit(actor, "action_item_created", incident_id, details={"id": it["id"], "priority": prio})
    return it


def update(store, item_id: str, body: dict, actor: str, now: float) -> dict:
    it = store.get_action_item(item_id)
    if it is None:
        raise KeyError(item_id)
    ch = {k: (str(body[k]).strip()[:500] or None) for k in ("title", "owner", "ref", "note") if k in body}
    if "due_at" in body and body["due_at"]:
        ch["due_at"] = float(body["due_at"])
    st = body.get("status")
    if st is not None:
        if st not in STATUSES:
            raise ValueError(f"status phải là {'|'.join(STATUSES)}")
        if st == "done" and not (ch.get("ref") or it.get("ref")):
            raise ValueError("đánh dấu xong phải dẫn PR/ticket (ref)")
        if st == "wontfix" and not (ch.get("note") or it.get("note")):
            raise ValueError("không làm thì phải ghi lý do (note)")
        ch["status"] = st
        ch["closed_at"] = now if st != "open" else None
    out = store.update_action_item(item_id, **ch)
    store.audit(actor, "action_item_updated", it["incident_id"], details={"id": item_id, "fields": sorted(ch)})
    return out


def view(it: dict, now: float) -> dict:
    overdue = it["status"] == "open" and now > float(it["due_at"])
    on_time = None if it["status"] != "done" else float(it["closed_at"]) <= float(it["due_at"])
    return {**it, "overdue": overdue, "on_time": on_time, "due_in_days": round((float(it["due_at"]) - now) / DAY, 1)}


def report(store, now: float, days: int = 90) -> dict:
    since = now - days * DAY
    items = [view(i, now) for i in store.action_items()]
    recent = [i for i in items if float(i["created_at"]) >= since]
    due_window = [i for i in recent if float(i["due_at"]) <= now]                 # việc đã tới hạn trong cửa sổ
    done_on_time = [i for i in due_window if i["status"] == "done" and i["on_time"]]
    closed = [float(i["closed_at"]) - float(i["created_at"]) for i in recent if i["status"] == "done" and i.get("closed_at")]
    open_items = [i for i in items if i["status"] == "open"]
    owners: dict[str, dict] = {}
    for i in open_items:
        o = owners.setdefault(i.get("owner") or "(chưa giao)", {"owner": i.get("owner") or "(chưa giao)", "open": 0, "overdue": 0})
        o["open"] += 1
        o["overdue"] += int(i["overdue"])
    open_items.sort(key=lambda i: (not i["overdue"], i["priority"], float(i["due_at"])))
    return {"days": days, "open": len(open_items), "overdue": sum(1 for i in open_items if i["overdue"]),
            "unassigned": sum(1 for i in open_items if not i.get("owner")),
            "on_time_rate": round(len(done_on_time) / len(due_window), 3) if due_window else None,
            "median_close_days": round(statistics.median(closed) / DAY, 1) if closed else None,
            "owners": sorted(owners.values(), key=lambda o: (-o["overdue"], -o["open"])), "items": open_items[:200]}
