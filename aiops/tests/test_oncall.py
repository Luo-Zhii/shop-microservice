"""Lịch trực luân phiên + leo thang: xoay ca theo tuần (bọc vòng), override, leo thang đúng ngưỡng và chỉ một lần,
sự cố đã nhận không leo thang, sự cố mới gắn người trực chính."""

from datetime import datetime, timezone, timedelta

from aiops.oncall import escalate, schedule, shift

VN = timezone(timedelta(hours=7))
START = datetime(2026, 11, 2, 9, tzinfo=VN).timestamp()
CFG = {"start": "2026-11-02T09:00:00+07:00", "escalate_after_minutes": 15,
       "rotation": [{"name": "A", "handle": "@a"}, {"name": "B", "handle": "@b"}, {"name": "C", "handle": "@c"}],
       "overrides": [{"from": "2026-11-24T09:00:00+07:00", "to": "2026-11-25T09:00:00+07:00", "primary": "C"}]}


def test_rotation_and_override():
    w = 7 * 86400
    assert shift(CFG, START + 10)["primary"]["name"] == "A" and shift(CFG, START + 10)["secondary"]["name"] == "B"
    assert shift(CFG, START + w + 10)["primary"]["name"] == "B"
    assert shift(CFG, START + 2 * w + 10)["secondary"]["name"] == "A"          # bọc vòng
    assert shift(CFG, START + 3 * w - 1)["primary"]["name"] == "C"             # 1 giây trước giờ đổi ca
    nov24 = datetime(2026, 11, 24, 12, tzinfo=VN).timestamp()                   # tuần 4 → A, nhưng override → C
    s = shift(CFG, nov24)
    assert s["primary"]["name"] == "C" and s["override"] and s["secondary"]["name"] == "B"
    sch = schedule(CFG, START + 10)
    assert [x["primary"]["name"] for x in sch] == ["A", "B", "C", "A"]
    assert shift({"rotation": []}, START) is None


class _N:
    def __init__(self):
        self.sent = []

    def notify(self, title, body, **kw):
        self.sent.append((title, body))
        return []


def test_escalation_once_and_ack(tmp_path):
    from aiops.agent.store import IncidentStore

    st = IncidentStore(f"sqlite:///{tmp_path / 'o.db'}")
    now = START + 3600
    old = st.create_incident(service="order", status="open", severity="critical", title="x", detected_at=now - 20 * 60)
    cart = st.create_incident(service="cart", status="open", severity="warning", title="y", detected_at=now - 5 * 60)  # chưa tới ngưỡng
    st.create_incident(service="search", status="open", severity="warning", title="z", detected_at=now - 30 * 60,
                       acknowledged_at=now - 25 * 60)                                                                    # đã có người nhận
    n = _N()
    r = escalate(st, n, CFG, now)
    assert [x["incident"] for x in r] == [old["id"]] and r[0]["to"] == "B" and r[0]["minutes_open"] == 20
    assert "@b" in n.sent[0][1] and "LEO THANG" in n.sent[0][0]
    # 10 phút sau: cart đủ 15 phút → leo thang lần đầu; order KHÔNG bị leo thang lặp
    assert [x["incident"] for x in escalate(st, n, CFG, now + 600)] == [cart["id"]] and len(n.sent) == 2


def test_incident_gets_assignee_and_api(tmp_path):
    from .test_agent_api import alert
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        inc_id = c.post("/webhooks/alertmanager", json={"status": "firing", "alerts": [alert("catalog")]}).json()["incidents"][0]
        cur = c.get("/oncall").json()
        assert st.get_incident(inc_id)["assignee"] == cur["current"]["primary"]["name"]
        assert len(cur["schedule"]) == 4 and cur["escalate_after_minutes"] == 15
