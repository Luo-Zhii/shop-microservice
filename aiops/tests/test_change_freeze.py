"""Đóng băng thay đổi quanh flash sale: chạm đường mua hàng trong cửa sổ → high + duyệt tay; service ngoài phạm vi hoặc
ngoài cửa sổ → không ảnh hưởng; emergency → bỏ qua nhưng ghi audit; promotion lỗi → fail-open, ghi rõ."""

from datetime import datetime, timezone

import httpx
from fastapi.testclient import TestClient

from aiops.agent.kube import RecordingBackend, StaticInspector
from aiops.agent.notifier import Notifier
from aiops.api import create_app
from aiops.config import load_settings
from aiops.llm import NoneProvider

NOW = 1_800_000_000.0
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
SALE = (NOW + 3600, NOW + 7200)   # sale bắt đầu sau 1 giờ (trong cửa sổ trước 2 giờ)


def _client(tmp_path, promo):
    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'f.db'}", str(tmp_path / "a.jsonl"), False
    return TestClient(create_app(s, promotion_transport=httpx.MockTransport(promo), loki=None, inspector=StaticInspector(),
                                 backend=RecordingBackend(), notifier=Notifier("", "", enabled=False), llm=NoneProvider(),
                                 clock=lambda: NOW, prom=None))


def _promo(req):
    lo, hi = (datetime.fromisoformat(req.url.params[k].replace("Z", "+00:00")).timestamp() for k in ("from", "to"))
    return httpx.Response(200, json={"items": [{"startsAt": iso(SALE[0]), "endsAt": iso(SALE[1])}] if SALE[0] <= hi and SALE[1] >= lo else []})


def test_freeze_window_forces_manual_approval(tmp_path):
    small = [{"path": "services/cart/src/a.ts", "lines": 3}, {"path": "services/cart/test/a.test.ts", "lines": 3}]
    with _client(tmp_path, _promo) as c:
        at = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat()  # noqa: E731
        r = c.post("/change-risk", json={"files": small, "at": at(NOW)}).json()
        assert r["freeze"]["active"] and r["freeze"]["services"] == ["cart"]
        assert r["level"] == "high" and r["rollout"]["approval"] == "manual" and "Đóng băng" in r["reasons"][0]
        assert "sau 60 phút" in r["policy"]
        # service ngoài đường mua hàng: không đóng băng, giữ mức thấp
        r = c.post("/change-risk", json={"files": [{"path": "services/review/src/a.ts", "lines": 3},
                                                   {"path": "services/review/test/a.test.ts", "lines": 3}], "at": at(NOW)}).json()
        assert r["freeze"] is None and r["level"] == "low"
        # ngoài cửa sổ: 4 giờ trước sale (> before 120 phút)
        r = c.post("/change-risk", json={"files": small, "at": at(SALE[0] - 4 * 3600)}).json()
        assert r["freeze"] is None
        # trong sale + sau sale 30 phút (after 60 phút) vẫn đóng băng
        assert c.post("/change-risk", json={"files": small, "at": at(SALE[1] + 1800)}).json()["freeze"]["active"]
        # khẩn cấp: bỏ qua, không ép mức, có audit
        r = c.post("/change-risk", json={"files": small, "at": at(NOW), "emergency": True, "reason": "hotfix thanh toán"},
                   headers={"x-actor": "oncall@shopnow.local"}).json()
        assert r["freeze"]["bypassed"] and r["level"] == "low" and r["reasons"][0].startswith("KHẨN CẤP")
        rows = c.app.state.responder.store._exec("SELECT actor, event FROM audit WHERE event = 'change_freeze_bypassed'")
        assert rows == [{"actor": "oncall@shopnow.local", "event": "change_freeze_bypassed"}]


def test_freeze_fails_open_when_promotion_down(tmp_path):
    with _client(tmp_path, lambda r: httpx.Response(503)) as c:
        r = c.post("/change-risk", json={"files": [{"path": "services/order/src/a.ts", "lines": 3}]}).json()
        assert r["freeze"] == {"active": False, "error": "không đọc được lịch flash sale — chưa áp đóng băng"}
        assert not any("Đóng băng" in x for x in r["reasons"])


def test_freeze_windows_listing(tmp_path):
    with _client(tmp_path, _promo) as c:
        r = c.get("/change-risk/freeze-windows?hours=24").json()
        assert r["enabled"] and "cart" in r["services"] and len(r["items"]) == 1
        w = r["items"][0]
        assert w["sale_starts"] == iso(SALE[0]) and w["starts"] == iso(SALE[0] - 7200) and w["active"] is True
    with _client(tmp_path, lambda r: httpx.Response(503)) as c:
        r = c.get("/change-risk/freeze-windows").json()
        assert r["items"] == [] and "không đọc được" in r["error"]
