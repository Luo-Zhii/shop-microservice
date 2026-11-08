"""Phát hiện bất thường trên metric — dùng CHUNG cho vòng lặp thật và bộ đánh giá tổng hợp.

Đặc trưng thô mỗi service mỗi bước 30s: p95 (s), err (tỉ lệ 5xx), rps, cpu (core), mem (MB), dlq (msg/s).
Đặc trưng dẫn xuất (DERIVED): log độ trễ (ms), err, log rps, CPU trên mỗi request (tách quá tải hợp lệ khỏi
CPU hog), mem, log dlq. Mỗi đặc trưng có "chiều xấu": p95/err/cpu_per_req/mem/dlq tăng là xấu, rps GIẢM là xấu.

1. Robust z-score: z_t = (x_t − median_W)/(1.4826·MAD_W) trên cửa sổ trượt W điểm trước t, chỉ lấy chiều xấu;
   điểm bị coi là bất thường không được đưa vào cửa sổ (tránh "học" luôn sự cố kéo dài). Sàn MAD theo đặc trưng.
2. IsolationForest đa biến: huấn luyện trên đoạn bình thường, đầu vào là độ lệch chuẩn hoá có hướng
   (chiều tốt bị cắt về 0); điểm thô −score_samples được hiệu chỉnh về [0..1] bằng sigmoid quanh phân vị 99.5%
   của tập huấn luyện.
   Hạn chế đã biết: cây cô lập chỉ chia trong miền dữ liệu huấn luyện nên điểm vượt xa max của MỘT đặc trưng
   có độ sâu ≈ điểm cực trị của tập train (không "ngoại suy") → IF đơn lẻ bỏ sót lệch đơn biến lớn.
3. Ensemble AIOps = max(trung bình(IF, z), σ(1.5·(zmax − 2·ngưỡng_z))) → lọc bền vững k bước liên tiếp.
   (So trên seed giữ riêng 1000–1011, khác seed báo cáo: mean ít báo động giả nhất; max/noisy-OR kéo theo báo động
   giả của IF; nhánh "z rất mạnh" tăng recall mà không thêm báo động giả.)
4. Baseline ngưỡng tĩnh: err > 5% hoặc p95 > 1s (cùng lọc k bước, giống `for: 1m` của PrometheusRule).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from sklearn.ensemble import IsolationForest

RAW_FEATURES = ("p95", "err", "rps", "cpu", "mem", "dlq")
DERIVED = ("p95", "err", "rps", "cpu", "mem", "dlq")  # cùng tên, đã biến đổi (cpu = cpu/request)
# +1: tăng là xấu, −1: giảm là xấu
DIRECTION = np.array([1, 1, -1, 1, 1, 1], dtype=float)
# sàn độ lệch chuẩn robust (đơn vị đặc trưng dẫn xuất) + phần tương đối theo |median|.
# dlq là chuỗi đếm thưa (median = MAD = 0): sàn 0.4 trên log1p(msg/phút) để 1 message lẻ (≈1.1) không vượt ngưỡng,
# còn ≥ ~5 msg/phút thì vượt — tức sàn phản ánh nhiễu lượng tử hoá của đếm chứ không phải nhiễu đo.
ABS_FLOOR = np.array([0.08, 0.004, 0.05, 0.0002, 5.0, 0.4])
REL_FLOOR = np.array([0.0, 0.10, 0.03, 0.05, 0.02, 0.0])


def derive(raw: dict[str, np.ndarray]) -> np.ndarray:
    """dict đặc trưng thô (mỗi mảng dài T, NaN = thiếu) → ma trận T×6 dẫn xuất (NaN được lấp tiến/0)."""
    T = max(len(v) for v in raw.values())

    def get(name: str) -> np.ndarray:
        v = np.asarray(raw.get(name, np.zeros(T)), dtype=float)
        if len(v) < T:
            v = np.concatenate([np.full(T - len(v), np.nan), v])
        return _ffill(v)

    p95, err, rps, cpu, mem, dlq = (get(n) for n in RAW_FEATURES)
    X = np.column_stack([
        np.log1p(np.maximum(p95, 0) * 1000.0),
        np.clip(err, 0, 1),
        np.log1p(np.maximum(rps, 0)),
        np.maximum(cpu, 0) / (np.maximum(rps, 0) + 1.0),
        np.maximum(mem, 0),
        np.log1p(np.maximum(dlq, 0) * 60.0),
    ])
    return X


def _ffill(v: np.ndarray) -> np.ndarray:
    out = v.copy()
    mask = np.isnan(out)
    if mask.all():
        return np.zeros_like(out)
    idx = np.where(~mask, np.arange(len(out)), 0)
    np.maximum.accumulate(idx, out=idx)
    out = out[idx]
    first = np.argmax(~mask)
    out[:first] = out[first]
    return out


def robust_scale(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    med = np.median(X, axis=0)
    mad = 1.4826 * np.median(np.abs(X - med), axis=0)
    return med, np.maximum(mad, ABS_FLOOR + REL_FLOOR * np.abs(med))


def directed(dev: np.ndarray) -> np.ndarray:
    """Giữ độ lệch theo chiều xấu (>0), chiều tốt cắt về 0."""
    return np.maximum(dev * DIRECTION, 0.0)


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.clip(x, -50, 50)))


@dataclass
class RobustZ:
    window: int = 60
    threshold: float = 4.5
    min_history: int = 10

    def score(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """→ (score01[T], zmax[T], z[T×F]). Online: chỉ dùng quá khứ, bỏ điểm bất thường khỏi cửa sổ."""
        T, F = X.shape
        z = np.zeros((T, F))
        normal = np.ones(T, dtype=bool)
        for t in range(T):
            lo = max(0, t - 3 * self.window)
            hist_idx = np.nonzero(normal[lo:t])[0][-self.window:] + lo
            if len(hist_idx) < self.min_history:
                continue
            med, sd = robust_scale(X[hist_idx])
            z[t] = directed((X[t] - med) / sd)
            if z[t].max() >= self.threshold:
                normal[t] = False
        zmax = z.max(axis=1)
        return sigmoid((zmax - self.threshold) * 1.5), zmax, z


@dataclass
class IForest:
    n_estimators: int = 64
    random_state: int = 0
    calib_quantile: float = 0.995
    model: IsolationForest | None = None
    med: np.ndarray | None = None
    sd: np.ndarray | None = None
    thr: float = 0.0
    scale: float = 1.0

    def fit(self, X_train: np.ndarray) -> "IForest":
        self.med, self.sd = robust_scale(X_train)
        Z = self._transform(X_train)
        self.model = IsolationForest(n_estimators=self.n_estimators, max_samples=min(256, len(Z)),
                                     random_state=self.random_state).fit(Z)
        raw = -self.model.score_samples(Z)
        self.thr = float(np.quantile(raw, self.calib_quantile))
        self.scale = max(float(self.thr - np.median(raw)), 1e-3)
        return self

    def _transform(self, X: np.ndarray) -> np.ndarray:
        return np.minimum(directed((X - self.med) / self.sd), 50.0)

    def raw(self, X: np.ndarray) -> np.ndarray:
        return -self.model.score_samples(self._transform(X))

    def score(self, X: np.ndarray) -> np.ndarray:
        return sigmoid((self.raw(X) - self.thr) / (0.25 * self.scale))

    def contributions(self, x: np.ndarray) -> dict[str, float]:
        """Độ lệch chuẩn hoá có hướng của từng đặc trưng ở một điểm — dùng làm bằng chứng."""
        d = self._transform(x.reshape(1, -1))[0]
        return {n: round(float(v), 2) for n, v in zip(DERIVED, d)}


def static_flags(raw: dict[str, np.ndarray], err_thr: float = 0.05, p95_thr: float = 1.0) -> np.ndarray:
    err = np.nan_to_num(np.asarray(raw.get("err"), dtype=float))
    p95 = np.nan_to_num(np.asarray(raw.get("p95"), dtype=float))
    return (err > err_thr) | (p95 > p95_thr)


def persist(flags: np.ndarray, k: int = 2) -> np.ndarray:
    """flag_t = True khi k bước liên tiếp kết thúc tại t đều True."""
    flags = np.asarray(flags, dtype=bool)
    if k <= 1:
        return flags
    run = np.zeros(len(flags), dtype=int)
    c = 0
    for i, f in enumerate(flags):
        c = c + 1 if f else 0
        run[i] = c
    return run >= k


def ensemble(if_score: np.ndarray, z_score: np.ndarray, zmax: np.ndarray | None = None,
             z_threshold: float = 4.5) -> np.ndarray:
    """mean(IF, z); riêng lệch đơn biến RẤT mạnh (zmax ≥ 2×ngưỡng) tự đủ cảnh báo — bù chỗ IF "mù" với đặc trưng
    hằng số/vượt miền huấn luyện (vd DLQ = 0 suốt tập train rồi bật lên)."""
    s = 0.5 * (np.asarray(if_score) + np.asarray(z_score))
    if zmax is not None:
        s = np.maximum(s, sigmoid(1.5 * (np.asarray(zmax) - 2 * z_threshold)))
    return s


@dataclass
class ServiceScores:
    service: str
    iforest: np.ndarray
    zscore: np.ndarray
    combined: np.ndarray
    zmax: np.ndarray
    z: np.ndarray
    static: np.ndarray
    top_features: list[tuple[str, float]] = field(default_factory=list)


def score_service(service: str, raw: dict[str, np.ndarray], train_slice: slice, *, z_window: int = 60,
                  z_threshold: float = 4.5, static_err: float = 0.05, static_p95: float = 1.0,
                  n_estimators: int = 64, random_state: int = 0, model: IForest | None = None) -> ServiceScores:
    X = derive(raw)
    if model is None:
        model = IForest(n_estimators=n_estimators, random_state=random_state).fit(X[train_slice])
    s_if = model.score(X)
    s_z, zmax, z = RobustZ(window=z_window, threshold=z_threshold).score(X)
    last = z[-1]
    top = sorted(((n, float(v)) for n, v in zip(DERIVED, last) if v > 0), key=lambda kv: -kv[1])[:3]
    return ServiceScores(service, s_if, s_z, ensemble(s_if, s_z, zmax, z_threshold), zmax, z,
                         static_flags(raw, static_err, static_p95), [(n, round(v, 2)) for n, v in top])
