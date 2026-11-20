"""Chấm rủi ro thay đổi: đặc trưng từ diff, mức + canary đề xuất, fit học lại trọng số, endpoint dùng lịch sử sự cố."""

from datetime import datetime

import numpy as np

from aiops.change_risk import PRIOR, Change, fit, score

from .test_mcp_investigator import incident, make_app



def test_small_tested_change_is_low_risk():
    ch = Change([("services/review/src/routes.ts", 20), ("services/review/test/review.test.ts", 15)], when=datetime(2026, 11, 18, 3, 0).astimezone())
    x = ch.features()
    assert x["no_tests"] == 0 and x["migration"] == 0 and ch.services() == ["review"]
    r = score({**x, "after_hours": 0})
    assert r["level"] == "low" and r["rollout"]["approval"] == "auto"


def test_migration_on_payment_without_tests_at_night_is_high_risk():
    ch = Change([("services/payment/migrations/004_split.sql", 300), ("services/payment/src/repo.ts", 900),
                 ("packages/contracts/src/index.ts", 40)], when=datetime(2026, 11, 21, 23, 30).astimezone(), incidents_30d={"payment": 3})
    r = score(ch.features())
    assert r["level"] == "high" and r["rollout"]["approval"] == "manual" and r["rollout"]["steps"][0] == 5
    assert {"migration", "shared", "no_tests", "critical"} <= set(r["contributions"])
    assert r["probability"] > 0.8


def test_fit_learns_signal_from_history():
    rng = np.random.default_rng(3)
    X, y = [], []
    for _ in range(600):
        x = {"lines": rng.uniform(0, 3), "migration": float(rng.random() < 0.2), "shared": float(rng.random() < 0.1),
             "critical": float(rng.random() < 0.4), "no_tests": float(rng.random() < 0.3), "after_hours": float(rng.random() < 0.3),
             "incidents_30d": rng.uniform(0, 1)}
        # sự thật ẩn: migration rất nguy hiểm, giờ deploy không quan trọng
        z = -3 + 3.0 * x["migration"] + 0.8 * x["lines"] + 0.0 * x["after_hours"]
        X.append(x)
        y.append(int(rng.random() < 1 / (1 + np.exp(-z))))
    w = fit(X, y)
    assert w["migration"] > PRIOR["migration"] + 0.5      # học được migration nặng hơn prior
    assert abs(w["after_hours"]) < PRIOR["after_hours"]   # và giờ deploy nhẹ hơn prior


def test_endpoint_uses_incident_history(tmp_path):
    with make_app(tmp_path) as c:
        body = {"files": [{"path": "services/catalog/src/routes.ts", "lines": 120}], "at": "2026-11-18T03:00:00Z"}
        before = c.post("/change-risk", json=body).json()
        incident(c, "catalog")
        after = c.post("/change-risk", json=body).json()
        assert before["services"] == ["catalog"] and after["incidents_30d"] == {"catalog": 1}
        assert after["probability"] > before["probability"]
        assert c.post("/change-risk", json={"files": []}).status_code == 400
