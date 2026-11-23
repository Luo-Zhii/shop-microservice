"""Diễn tập sự cố: kế hoạch ưu tiên runbook chưa tập/quá hạn, một buổi tại một thời điểm, mốc đúng thứ tự, đo TTD/TTR,
so với MTTR thật; runbook không có chaos → diễn tập trên bàn."""

from aiops.drills import plan, summary

NOW = 1_800_000_000.0
RB = [{"id": "RB-001", "title": "a", "file": "f", "services": [], "chaos": "http-abort-catalog"},
      {"id": "RB-002", "title": "b", "file": "f", "services": [], "chaos": "cpu-stress-inventory"},
      {"id": "RB-007", "title": "c", "file": "f", "services": [], "chaos": None}]


def test_plan_priorities():
    drills = [{"runbook": "RB-001", "status": "completed", "started_at": NOW - 10 * 86400},
              {"runbook": "RB-002", "status": "completed", "started_at": NOW - 120 * 86400},
              {"runbook": "RB-002", "status": "aborted", "started_at": NOW - 1 * 86400}]          # buổi huỷ không tính
    p = plan(RB, drills, NOW, cadence_days=90, k=2)
    by = {i["id"]: i for i in p["items"]}
    assert p["suggested"] == ["RB-007", "RB-002"]              # chưa từng tập > quá hạn 120 ngày
    assert by["RB-001"]["overdue"] is False and by["RB-002"]["overdue"] and by["RB-002"]["days_since"] == 120.0
    assert by["RB-007"]["mode"] == "tabletop" and by["RB-007"]["command"] is None
    assert by["RB-001"]["command"] == "kubectl apply -f platform/chaos/experiments/http-abort-catalog.yaml"
    assert p["overdue"] == 2


def test_summary_vs_real():
    d = [{"status": "completed", "started_at": 0, "detected_at": 120, "resolved_at": 900, "followed_runbook": 1},
         {"status": "completed", "started_at": 0, "detected_at": 300, "resolved_at": 1500, "followed_runbook": 0},
         {"status": "aborted", "started_at": 0}]
    inc = [{"detected_at": 100, "fault_start": 0, "resolved_at": 1800}, {"detected_at": 0, "resolved_at": 600}]
    s = summary(d, inc)
    assert s == {"drills": 2, "ttd_median_s": 210.0, "ttr_median_s": 1200.0, "real_mttr_median_s": 1200.0,
                 "runbook_followed_ratio": 0.5}


def test_drill_api_flow(tmp_path):
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        clock = c.app.state.responder.clock
        p = c.get("/drills/plan").json()
        assert p["overdue"] == 8 and len(p["suggested"]) == 3                   # 8 runbook chưa từng tập
        assert c.post("/drills", json={"runbook": "RB-999"}).status_code == 404
        d = c.post("/drills", json={"runbook": "RB-005"}, headers={"x-actor": "sre@shopnow.local"}).json()
        assert d["chaos"] == "network-delay-warehouse" and d["environment"] == "staging" and d["status"] == "running"
        assert c.post("/drills", json={"runbook": "RB-001"}).status_code == 409   # một buổi tại một thời điểm
        assert c.post(f"/drills/{d['id']}/mark", json={"event": "resolved"}).status_code == 409   # nhảy cóc
        assert c.post(f"/drills/{d['id']}/complete", json={}).status_code == 409                   # chưa khôi phục
        for ev in ("detected", "mitigated", "resolved"):
            assert c.post(f"/drills/{d['id']}/mark", json={"event": ev}).status_code == 200
        assert c.post(f"/drills/{d['id']}/mark", json={"event": "detected"}).status_code == 409    # không ghi đè
        done = c.post(f"/drills/{d['id']}/complete", json={"followed_runbook": True, "notes": "tăng người ca chiều"}).json()
        assert done["status"] == "completed" and done["ttr_s"] is not None and done["followed_runbook"] == 1
        lst = c.get("/drills").json()
        assert lst["summary"]["drills"] == 1 and lst["summary"]["runbook_followed_ratio"] == 1.0
        assert "RB-005" not in c.get("/drills/plan").json()["suggested"]
