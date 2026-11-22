"""Giao tiếp sự cố an toàn: bộ lọc rò rỉ thông tin nội bộ chặn ở server; nháp mẫu tất định; LLM viết lộ → bị loại, về mẫu."""

from aiops.statuspage import draft_update, lint_public

TERMS = ["payment", "order", "shopnow", "HighErrorRate"]


def test_lint_catches_internal_details_but_not_plain_text():
    ok = "Một số khách không thanh toán được bằng thẻ trên trang web. Chúng tôi đang khắc phục."
    assert lint_public(ok, TERMS) == []
    bad = {
        "Lỗi ở payment service": "payment",
        "Alert HighErrorRate đang bắn": "HighErrorRate",
        "Máy 10.0.3.17 quá tải": "IP",
        "pod payment-7d9f8b6c5d-x2k4p restart": "pod",
        "gọi http://payment.shopnow.svc lỗi": "tên miền nội bộ",
        "Traceback khi gọi cổng": "chi tiết lỗi",
        "đã rollback về sha-1a2b3c4d": "mã phiên bản",
        "đang xem trên Grafana": "công cụ vận hành",
    }
    for text, kind in bad.items():
        found = lint_public(text, TERMS)
        assert found, text
        assert any(kind.lower() in f.lower() or kind in f for f in found), (text, found)


def test_template_draft_is_clean_by_design():
    comps = [{"id": "checkout", "name": "Đặt hàng & thanh toán", "services": ["order", "payment"]}]
    inc = {"service": "payment", "severity": "critical"}
    for phase in ("investigating", "identified", "monitoring", "resolved"):
        d = draft_update(inc, comps, phase)
        assert lint_public(d["title"] + "\n" + d["message"], TERMS) == [], d
        assert "đặt hàng và thanh toán" in d["message"]
    assert draft_update(inc, comps, "investigating")["impact"] == "major_outage"
    assert draft_update(inc, comps, "resolved")["title"].startswith("Đã khắc phục")


class _LLM:
    name, available = "fake-llm", True

    def __init__(self, text):
        self.text = text

    def chat(self, messages, system=None, max_tokens=1024):
        assert "TUYỆT ĐỐI không nêu tên hệ thống nội bộ" in system
        return self.text


def test_api_blocks_leaks_and_llm_draft_guarded(tmp_path):
    from .test_mcp_investigator import make_app

    with make_app(tmp_path) as c:
        st = c.app.state.responder.store
        inc = st.create_incident(service="payment", namespace="shopnow", severity="critical", title="x", source="t",
                                 detected_at=c.app.state.responder.clock() - 60, status="open",
                                 alerts=[{"alertname": "PaymentGatewayDown"}])
        url = f"/incidents/{inc['id']}/status-updates"
        r = c.post(url, json={"status": "investigating", "title": "Thanh toán gián đoạn",
                              "message": "Pod payment-7d9f8b6c5d-x2k4p bị OOMKilled, PaymentGatewayDown đang bắn."})
        assert r.status_code == 422 and r.json()["error"]["code"] == "INTERNAL_INFO_LEAK"
        assert len(r.json()["error"]["details"]["problems"]) >= 2 and not st.status_updates(inc["id"])
        # nháp mẫu
        d = c.get(f"/incidents/{inc['id']}/status-draft?phase=identified").json()
        assert d["provider"] == "template" and d["lint"] == [] and "đặt hàng và thanh toán" in d["message"]
        assert c.post(url, json={"status": "identified", "title": d["title"], "message": d["message"], "impact": d["impact"]}).status_code == 200
        # LLM viết lộ tên service → loại, giữ bản mẫu; LLM viết sạch → dùng
        c.app.state.responder.llm = _LLM("Dịch vụ payment trên máy 10.0.0.5 đang lỗi, chúng tôi đang xử lý.")
        d2 = c.get(f"/incidents/{inc['id']}/status-draft").json()
        assert d2["provider"] == "template" and d2["llm_rejected"]
        c.app.state.responder.llm = _LLM("Một số quý khách chưa thanh toán được đơn hàng. Chúng tôi đang khẩn trương xử lý.")
        d3 = c.get(f"/incidents/{inc['id']}/status-draft").json()
        assert d3["provider"] == "fake-llm" and d3["message"].startswith("Một số quý khách") and d3["lint"] == []
