"""Sự cố sinh ra trong buổi diễn tập: gắn drill_id, KHÔNG vào uptime/SLA trang trạng thái, DORA, nhãn change-risk, chất
lượng cảnh báo; bản tin ca vẫn đếm nhưng ghi rõ; hết diễn tập thì sự cố mới không bị gắn nhãn."""


def test_drill_incidents_excluded(tmp_path):
    from .test_agent_api import alert
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        r = c.app.state.responder
        st, now = r.store, r.clock()
        d = c.post("/drills", json={"runbook": "RB-001"}).json()
        inc_id = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert("catalog", name="ShopNowHighErrorRate")]}).json()["incidents"][0]
        inc = st.get_incident(inc_id)
        assert inc["drill_id"] == d["id"]
        assert c.get(f"/incidents/{inc_id}").json().get("drill_id", inc["drill_id"]) == d["id"]
        st.update_incident(inc_id, status="resolved", resolved_at=now + 600)
        # mọi chỗ tính số liệu đều bỏ qua sự cố diễn tập
        assert st.list_incidents(exclude_drills=True) == [] and len(st.list_incidents()) == 1
        browse = next(x for x in c.get("/status/public").json()["components"] if x["id"] == "browse")
        assert browse["status"] == "operational" and browse["uptime_90d"] == 1.0
        assert c.get("/reports/dora").json()["metrics"]["time_to_restore"]["value"] is None
        dep = st.add_deploy("d1", ["catalog"], {}, 0.1, now - 60)
        r.clock = lambda: now + 3 * 3600
        c.post("/change-risk/fit?min_records=5")
        assert next(x for x in st.deploys() if x["id"] == dep["id"])["label"] == 0     # không bị gắn "gây sự cố"
        dg = c.get("/reports/oncall-digest?hours=24").json()
        assert dg["incidents"]["drill"] == 1 and "do diễn tập" in dg["markdown"]
        # kết thúc diễn tập → sự cố mới là sự cố thật
        for ev in ("detected", "mitigated", "resolved"):
            c.post(f"/drills/{d['id']}/mark", json={"event": ev})
        c.post(f"/drills/{d['id']}/complete", json={"followed_runbook": True})
        inc2 = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert("search", name="ShopNowHighErrorRate")]}).json()["incidents"][0]
        assert st.get_incident(inc2)["drill_id"] is None


def test_old_db_gets_drill_column(tmp_path):
    import sqlite3

    from aiops.agent.store import IncidentStore

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE incidents (id TEXT PRIMARY KEY, service TEXT, status TEXT, detected_at DOUBLE PRECISION, alerts TEXT)")
    con.execute("INSERT INTO incidents VALUES ('old', 'catalog', 'open', 1.0, '[]')")
    con.commit(); con.close()
    st = IncidentStore(f"sqlite:///{path}")
    assert st.get_incident("old")["drill_id"] is None and len(st.list_incidents(exclude_drills=True)) == 1
