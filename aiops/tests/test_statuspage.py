"""Trang trạng thái công khai: uptime có trọng số (không cộng đôi phần chồng lấn), trạng thái nhóm chức năng, chỉ công bố
sự cố có thông báo của người trực, không lộ tên service/alert nội bộ; API đăng cập nhật + endpoint công khai."""

from datetime import datetime, timedelta, timezone

from aiops.agent.store import IncidentStore
from aiops.statuspage import build, uptime_days

VN = timezone(timedelta(hours=7))
D0 = datetime(2026, 11, 20, tzinfo=VN).timestamp()          # 00:00 20/11 giờ VN
NOW = D0 + 2 * 86400 + 12 * 3600                              # 12:00 22/11
COMPS = [{"id": "checkout", "name": "Đặt hàng & thanh toán", "services": ["order", "payment"]},
         {"id": "cart", "name": "Giỏ hàng & khuyến mãi", "services": ["cart"]}]


def _inc(st, svc, sev, start, end=None, **kw):
    return st.create_incident(service=svc, namespace="shopnow", severity=sev, title=f"HighErrorRate {svc} pod-xyz", source="test",
                              detected_at=start + 60, fault_start=start, resolved_at=end,
                              status="resolved" if end else "open", **kw)


def test_uptime_weighting_and_overlap(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'u.db'}")
    _inc(st, "payment", "critical", D0 + 3600, D0 + 3600 + 144 * 60)          # 20/11: 144 phút gián đoạn lớn → 90%
    _inc(st, "order", "warning", D0 + 3600, D0 + 3600 + 60 * 60)              # chồng lên → không cộng thêm
    part = _inc(st, "order", "warning", D0 + 86400 + 7200, D0 + 86400 + 7200 + 3600)  # 21/11: người trực khai "một phần"
    # không khai → warning = suy giảm, không trừ uptime; khai partial_outage → 60 phút × 30% = 18 phút
    assert {d["date"]: d["uptime"] for d in uptime_days(st.list_incidents(limit=100), {"order"}, NOW, 3)}["2026-11-21"] == 1.0
    days = {d["date"]: d for d in uptime_days(st.list_incidents(limit=100), {"order", "payment"}, NOW, 3,
                                              impacts={part["id"]: "partial_outage"})}
    assert days["2026-11-20"]["uptime"] == 0.9 and days["2026-11-20"]["status"] == "outage"
    assert days["2026-11-21"]["uptime"] == 0.9875 and days["2026-11-21"]["status"] == "degraded"
    assert days["2026-11-22"]["uptime"] == 1.0
    # sự cố vắt qua nửa đêm được chia đúng hai ngày
    st2 = IncidentStore(f"sqlite:///{tmp_path / 'v.db'}")
    _inc(st2, "payment", "critical", D0 + 86400 - 1800, D0 + 86400 + 1800)
    d2 = {d["date"]: d["uptime"] for d in uptime_days(st2.list_incidents(limit=10), {"payment"}, NOW, 3)}
    assert d2["2026-11-20"] == round(1 - 1800 / 86400, 5) == d2["2026-11-21"]


def test_build_publishes_only_human_updates(tmp_path):
    st = IncidentStore(f"sqlite:///{tmp_path / 'b.db'}")
    open_inc = _inc(st, "payment", "critical", NOW - 1800)
    _inc(st, "cart", "warning", NOW - 600)                                     # đang mở nhưng chưa ai viết thông báo
    st.add_status_update(open_inc["id"], "investigating", "Một số khách không thanh toán được bằng thẻ.", "oncall", NOW - 1500,
                         title="Thanh toán thẻ gián đoạn")
    st.add_status_update(open_inc["id"], "identified", "Đã xác định lỗi kết nối cổng thanh toán, đang khắc phục.", "oncall", NOW - 900)
    r = build(st, NOW, COMPS, synthetic_failed_services={"cart"})
    comp = {c["id"]: c for c in r["components"]}
    assert comp["checkout"]["status"] == "major_outage" and r["overall"] == "major_outage"
    assert comp["cart"]["status"] == "partial_outage"                          # robot tổng hợp hỏng ở giỏ hàng
    st.add_status_update(open_inc["id"], "monitoring", "Đã chuyển sang cổng dự phòng, đang theo dõi.", "oncall", NOW - 300,
                         impact="partial_outage")
    r = build(st, NOW, COMPS, synthetic_failed_services={"cart"})
    comp = {c["id"]: c for c in r["components"]}
    assert comp["checkout"]["status"] == "partial_outage"                      # người trực hạ mức ảnh hưởng
    assert len(r["active_incidents"]) == 1
    a = r["active_incidents"][0]
    assert a["title"] == "Thanh toán thẻ gián đoạn" and a["status"] == "monitoring" and a["components"] == ["Đặt hàng & thanh toán"]
    assert [u["status"] for u in a["updates"]] == ["monitoring", "identified", "investigating"]   # mới nhất trước
    text = str(r)
    assert "HighErrorRate" not in text and "pod-xyz" not in text and "payment" not in text   # không lộ nội bộ


def test_api_status_updates_and_public_endpoint(tmp_path):
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        inc = st.create_incident(service="order", namespace="shopnow", severity="critical", title="x", source="t",
                                 detected_at=c.app.state.responder.clock() - 300, status="open")
        url = f"/incidents/{inc['id']}/status-updates"
        assert c.post(url, json={"status": "investigating", "message": "Đang kiểm tra sự cố đặt hàng."}).status_code == 400  # thiếu tiêu đề
        assert c.post(url, json={"status": "bogus", "message": "x" * 20, "title": "t"}).status_code == 400
        assert c.post(url, json={"status": "investigating", "message": "x" * 20, "title": "t", "impact": "nuke"}).status_code == 400
        ok = c.post(url, json={"status": "investigating", "message": "Đang kiểm tra sự cố đặt hàng.", "title": "Đặt hàng chậm"},
                    headers={"x-actor": "oncall@shopnow.local"})
        assert ok.status_code == 200 and ok.json()["author"] == "oncall@shopnow.local"
        assert c.post(url, json={"status": "resolved", "message": "Đã khắc phục, đơn hàng bình thường."}).status_code == 200
        assert len(c.get(url).json()["items"]) == 2
        pub = c.get("/status/public")
        assert pub.headers["cache-control"] == "public, max-age=30"
        body = pub.json()
        assert body["overall"] == "major_outage" and body["active_incidents"] == []           # đã khắc phục nhưng sự cố chưa đóng
        assert body["recent_incidents"][0]["title"] == "Đặt hàng chậm"
        assert {c_["id"] for c_ in body["components"]} >= {"browse", "checkout"} and len(body["components"][0]["days"]) == 90
