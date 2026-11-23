"""Quyền tự động theo thành tích từng luật runbook (nâng/hạ có điều kiện, rollback không bao giờ tự nâng, bỏ dữ liệu diễn tập)
+ toil và ứng viên tự động hoá + bản vá runbook.yaml chỉ đổi đúng một dòng."""

import pytest

from aiops.agent.store import IncidentStore
from aiops.autonomy import patch_runbook, report
from aiops.config import DEFAULT_RUNBOOK

DAY = 86400.0
T0 = 1_800_000_000.0
NOW = T0 + 28 * DAY
RULES = [{"name": "restart-crashloop", "action": "restart", "approval": "required"},
         {"name": "rollback-after-bad-deploy", "action": "rollback", "approval": "required"},
         {"name": "scale-on-saturation", "action": "scale_up", "approval": "required"},
         {"name": "auto-restart-flaky", "action": "restart", "approval": "auto"},
         {"name": "notify-only", "action": "notify", "approval": "auto"}]


def seed(st, rule, svc, n, t, status="executed", wait=120.0, drill=None, alertname="A", ack_to_resolve=None, gap=DAY):
    out = []
    for k in range(n):
        at = t + k * gap
        inc = st.create_incident(service=svc, severity="warning", title=alertname, detected_at=at, drill_id=drill,
                                 alerts=[{"fingerprint": f"{svc}{k}", "alertname": alertname, "status": "resolved"}],
                                 acknowledged_at=at + 60, mitigated_at=at + 60 + wait if status == "executed" else None,
                                 resolved_at=at + 60 + (ack_to_resolve if ack_to_resolve is not None else wait + 300), status="resolved")
        if rule:
            st.create_action(incident_id=inc["id"], type="restart", status=status, approval="required", rule=rule,
                             created_at=at + 30, decided_at=at + 30 + wait, decided_by="an", executed_at=at + 30 + wait)
        out.append(inc)
    return out


def test_report(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'a.db'}")
    seed(st, "restart-crashloop", "cart", 10, T0 + DAY)                        # 10 lần duyệt, 0 từ chối, không tái diễn
    seed(st, "restart-crashloop", "cart", 1, T0 + 2 * DAY + 3600, status="rejected", drill="d1")   # diễn tập → bỏ qua
    seed(st, "rollback-after-bad-deploy", "order", 12, T0 + DAY)               # thành tích tốt nhưng rollback không tự nâng
    seed(st, "scale-on-saturation", "search", 9, T0 + DAY)
    seed(st, "scale-on-saturation", "search", 1, T0 + 20 * DAY, status="rejected")
    seed(st, "auto-restart-flaky", "payment", 3, T0 + DAY, status="failed")
    seed(st, "auto-restart-flaky", "payment", 3, T0 + 5 * DAY)
    seed(st, None, "catalog", 4, T0 + DAY, alertname="CatalogSlow", ack_to_resolve=1800)   # chỉ người xử lý, lặp 4 lần
    seed(st, None, "promotion", 2, T0 + DAY, alertname="PromoErr", ack_to_resolve=600)
    r = report(st, RULES, NOW, 28, oncall_people=3)
    by = {x["rule"]: x for x in r["rules"]}
    assert r["promote"] == ["restart-crashloop"] and by["restart-crashloop"]["decided"] == 10 and by["restart-crashloop"]["rejected"] == 0
    assert by["restart-crashloop"]["median_wait_s"] == 120.0
    assert by["rollback-after-bad-deploy"]["recommendation"] is None and "không thuộc nhóm" in by["rollback-after-bad-deploy"]["reasons"][0]
    assert "1 lần bị từ chối" in by["scale-on-saturation"]["reasons"][0]
    assert r["demote"] == ["auto-restart-flaky"] and by["auto-restart-flaky"]["success_rate"] == 0.5
    assert by["notify-only"]["recommendation"] is None
    # tự động hoá thất bại (payment) → người phải xử lý tay → cũng là toil, cũng là ứng viên (luật cần sửa)
    assert r["automation_candidates"] == [{"service": "catalog", "alertname": "CatalogSlow", "count": 4, "toil_minutes": 120.0},
                                          {"service": "payment", "alertname": "A", "count": 3, "toil_minutes": 21.0}]
    # toil = chờ duyệt (38 hành động ngoài diễn tập × 2 phút) + xử lý tay (catalog 4×30, promotion 2×10, payment thất bại
    # 3×7, search bị từ chối 1×7 phút) — giờ trực 3 người × 40 giờ × 4 tuần
    assert r["toil_hours"] == round((38 * 120 + 4 * 1800 + 2 * 600 + 4 * 420) / 3600, 2) and r["oncall_hours"] == 480.0
    assert not r["toil_over_budget"]


def test_recurrence_blocks_promotion(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'r.db'}")
    seed(st, "restart-crashloop", "cart", 10, T0 + DAY, gap=3600)   # sự cố cách nhau 1 giờ → restart chỉ che triệu chứng
    r = report(st, RULES, NOW, 28)
    rc = next(x for x in r["rules"] if x["rule"] == "restart-crashloop")
    assert rc["recommendation"] is None and rc["recurrence_rate"] == 0.9 and "tái diễn 90%" in rc["reasons"][0]


def test_patch_runbook():
    text = open(DEFAULT_RUNBOOK, encoding="utf-8").read()
    new = patch_runbook(text, "restart-crashloop", "auto")
    diff = [(a, b) for a, b in zip(text.splitlines(), new.splitlines()) if a != b]
    assert diff == [("    approval: required", "    approval: auto")] and len(new.splitlines()) == len(text.splitlines())
    with pytest.raises(KeyError):
        patch_runbook(text, "khong-co", "auto")


def test_api(tmp_path):
    from .test_mcp_investigator import NOW as API_NOW, make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        seed(st, "restart-crashloop", "cart", 10, API_NOW - 20 * DAY)
        r = c.get("/reports/autonomy").json()
        assert r["promote"] == ["restart-crashloop"] and r["oncall_hours"] == 480.0
        patch = next(x for x in r["rules"] if x["rule"] == "restart-crashloop")["patch"]
        assert "-    approval: required" in patch and "+    approval: auto" in patch
        assert "aiops_toil_share" in c.get("/metrics").text


def test_digest_mentions_autonomy(tmp_path):
    from .test_mcp_investigator import NOW as API_NOW, make_app

    with make_app(tmp_path) as c:
        seed(c.app.state.responder.store, "restart-crashloop", "cart", 10, API_NOW - 20 * DAY)
        att = c.get("/reports/oncall-digest").json()["attention"]
        assert any("bỏ duyệt tay" in a and "restart-crashloop" in a for a in att)
