"""Dự báo dung lượng: Holt-Winters bắt mùa vụ ngày + xu hướng, fallback Holt khi thiếu dữ liệu, đề xuất replica, endpoint."""

import httpx
import numpy as np
from fastapi.testclient import TestClient

from aiops.capacity import forecast, recommend

STEP = 900
DAY = 86400 // STEP  # 96 điểm/ngày


def daily(days: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(days * DAY)
    # nền 100 rps, cao điểm tối ~ +80, tăng trưởng nhẹ, nhiễu 5%
    return 100 + 80 * np.clip(np.sin(2 * np.pi * (t % DAY) / DAY - 1.2), 0, None) + 0.02 * t + rng.normal(0, 5, len(t))


def test_holt_winters_predicts_tomorrows_peak():
    x = daily(8)
    # cắt lúc tải đang lên (bước 32/96), cao điểm tối ở bước ~42 → dự báo 3 giờ tới phải thấy đỉnh trước khi nó tới
    hist, truth = x[: 7 * DAY + 32], x[7 * DAY + 32: 7 * DAY + 44]
    fc = forecast(hist, STEP, horizon_s=3 * 3600)
    assert fc["model"] == "holt-winters"
    assert abs(fc["peak"] - truth.max()) / truth.max() < 0.15
    naive = hist[-1]                                                  # baseline: giữ nguyên mức hiện tại
    assert abs(fc["peak"] - truth.max()) < abs(naive - truth.max())


def test_short_history_falls_back_to_holt_and_handles_gaps():
    x = np.linspace(10, 40, 50)
    x[10:15] = np.nan
    fc = forecast(x, STEP, horizon_s=3600)
    assert fc["model"] == "holt" and fc["peak"] >= 40


def test_recommend_replicas_clamped():
    assert recommend(peak=380, rmse=20, rps_per_pod=100, min_r=2, max_r=10) == 6     # (400 × 1.3)/100 = 5.2 → 6
    assert recommend(peak=10, rmse=0, rps_per_pod=100, min_r=2, max_r=10) == 2
    assert recommend(peak=5000, rmse=0, rps_per_pod=100, min_r=2, max_r=10) == 10


def test_endpoint_sets_keda_gauge(tmp_path):
    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    x = daily(8, seed=2)
    now = 1_800_000_000.0
    start = now - 8 * 86400

    def prom(req):
        values = [[start + i * STEP, str(v)] for i, v in enumerate(x)]
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix",
                              "result": [{"metric": {"service": "catalog"}, "values": values}]}})

    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl"), False
    app = create_app(s, prom=PrometheusClient("http://p", transport=httpx.MockTransport(prom)), loki=None,
                     inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                     llm=NoneProvider(), clock=lambda: now)
    with TestClient(app) as c:
        r = c.get("/capacity/forecast?hours=1").json()
        cat = r["items"][0]
        assert cat["service"] == "catalog" and cat["model"] == "holt-winters" and cat["rps_per_pod"] == 100
        assert 2 <= cat["recommended_min_replicas"] <= 10
        assert 'aiops_forecast_rps{service="catalog"}' in c.get("/metrics").text


def test_flash_sale_uplift_learned_and_applied(tmp_path):
    """Hai flash sale quá khứ ×3 tải → học hệ số ≈3; sale sắp tới trong horizon → đỉnh dự báo ≈3× nền, service ngoài
    đường mua hàng không bị nhân; promotion lỗi → vẫn dự báo (không có biến ngoại sinh)."""
    from datetime import datetime, timezone

    from aiops.agent.kube import RecordingBackend, StaticInspector
    from aiops.agent.notifier import Notifier
    from aiops.api import create_app
    from aiops.capacity import apply_events, event_uplift
    from aiops.collectors.prometheus import PrometheusClient
    from aiops.config import load_settings
    from aiops.llm import NoneProvider

    now = 1_800_000_000.0 - (1_800_000_000.0 % 86400)      # nửa đêm UTC cho dễ tính khung giờ
    start = now - 8 * 86400
    rng = np.random.default_rng(5)
    base = 100 + rng.normal(0, 3, 8 * DAY)
    x = base.copy()
    sales = [(start + d * 86400 + 13 * 3600, start + d * 86400 + 14 * 3600) for d in (3, 6)]   # 20h–21h giờ VN
    for s0, s1 in sales:
        x[int((s0 - start) // STEP): int((s1 - start) // STEP)] *= 3
    assert abs(event_uplift(x, start, STEP, sales) - 3.0) < 0.2
    assert event_uplift(x, start, STEP, [(start + 3600, start + 7200)]) is None          # không có hôm trước để so
    assert apply_events([10.0, 10.0, 10.0], now, STEP, [(now + STEP, now + 2 * STEP)], 3.0) == [10.0, 30.0, 10.0]

    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: E731
    upcoming = (now + 1800, now + 5400)

    def prom(req):
        mk = lambda svc: {"metric": {"service": svc}, "values": [[start + i * STEP, str(v)] for i, v in enumerate(x)]}  # noqa: E731
        return httpx.Response(200, json={"status": "success", "data": {"resultType": "matrix", "result": [mk("catalog"), mk("review")]}})

    def promo(req, down=False):
        assert req.headers["x-internal-token"] == "it"
        evs = [{"startsAt": iso(a), "endsAt": iso(b)} for a, b in sales + [upcoming]]
        return httpx.Response(200, json={"items": evs})

    import os
    os.environ["INTERNAL_TOKEN"] = "it"
    s = load_settings()
    s.db_url, s.audit_log, s.detector_enabled = f"sqlite:///{tmp_path / 'i.db'}", str(tmp_path / "a.jsonl"), False
    deps = dict(loki=None, inspector=StaticInspector(), backend=RecordingBackend(), notifier=Notifier("", "", enabled=False),
                llm=NoneProvider(), clock=lambda: now, prom=PrometheusClient("http://p", transport=httpx.MockTransport(prom)))
    with TestClient(create_app(s, promotion_transport=httpx.MockTransport(promo), **deps)) as c:
        r = c.get("/capacity/forecast?hours=2").json()
        by = {i["service"]: i for i in r["items"]}
        assert r["upcoming_flash_sales"] == 1 and r["past_flash_sales"] == 2
        assert abs(by["catalog"]["event_uplift"] - 3.0) < 0.2 and by["catalog"]["peak"] > 250
        assert by["review"]["event_uplift"] is None and by["review"]["peak"] < 150
    s.db_url = f"sqlite:///{tmp_path / 'j.db'}"
    with TestClient(create_app(s, promotion_transport=httpx.MockTransport(lambda r: httpx.Response(503)), **deps)) as c:
        r = c.get("/capacity/forecast?hours=2").json()
        assert r["upcoming_flash_sales"] == 0 and r["items"][0]["event_uplift"] is None
    os.environ.pop("INTERNAL_TOKEN")
