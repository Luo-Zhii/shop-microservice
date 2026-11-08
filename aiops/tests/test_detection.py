import numpy as np

from aiops.detection.metrics import IForest, RobustZ, derive, persist, score_service, static_flags


def normal(T=200, seed=0, **over):
    rng = np.random.default_rng(seed)
    raw = {"p95": 0.08 * rng.lognormal(0, 0.08, T), "err": rng.binomial(3000, 0.002, T) / 3000,
           "rps": rng.poisson(100 * 30, T) / 30, "cpu": 0.2 + rng.normal(0, 0.01, T), "mem": 200 + rng.normal(0, 2, T),
           "dlq": np.zeros(T)}
    raw.update(over)
    return raw


def test_derive_shape_and_ffill():
    raw = normal(50)
    raw["p95"][10:15] = np.nan
    X = derive(raw)
    assert X.shape == (50, 6) and not np.isnan(X).any()


def test_robust_z_flags_latency_step_but_not_noise():
    raw = normal()
    raw["p95"][150:] *= 4
    s, zmax, _ = RobustZ(window=60).score(derive(raw))
    assert (s[120:150] < 0.5).all()
    assert (s[151:170] > 0.9).all()  # sự cố kéo dài vẫn được giữ (cửa sổ bỏ điểm bất thường)


def test_directional_traffic_increase_not_anomalous():
    raw = normal()
    raw["rps"][150:] *= 2.0
    raw["cpu"][150:] *= 2.0  # CPU tăng theo tải → CPU/request không đổi
    s, _, _ = RobustZ().score(derive(raw))
    assert s[150:].max() < 0.5


def test_iforest_calibration_and_detection():
    raw = normal()
    # bất thường đa biến (lỗi + chậm + rớt lưu lượng cùng lúc) — kiểu IF bắt tốt
    raw["err"][160:] = 0.2
    raw["p95"][160:] *= 5
    raw["rps"][160:] *= 0.4
    X = derive(raw)
    m = IForest(random_state=1).fit(X[:120])
    sc = m.score(X)
    assert np.mean(sc[:120] >= 0.6) < 0.03          # hiệu chỉnh: ≤ ~0.5% điểm bình thường vượt 0.5
    assert np.median(sc[165:]) > np.quantile(sc[:120], 0.99)
    assert m.contributions(X[170])["err"] > 5


def test_static_and_persist():
    raw = normal(10)
    raw["err"][3] = 0.1
    raw["p95"][6:8] = 1.5
    f = static_flags(raw)
    assert f[3] and f[6] and f[7] and not f[0]
    p = persist(f, 2)
    assert not p[3] and p[7] and not p[6]


def test_score_service_top_features():
    raw = normal()
    raw["dlq"][-5:] = 1.0
    ss = score_service("payment", raw, slice(0, 150))
    assert ss.combined[-1] > 0.6 and ss.top_features[0][0] == "dlq"
