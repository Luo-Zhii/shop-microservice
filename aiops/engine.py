"""Vòng lặp detector: mỗi `step_seconds` lấy metric (Prometheus) + log (Loki) → điểm bất thường mỗi service
→ gauge `aiops_anomaly_score{service}` → khi vượt ngưỡng `persistence` bước liên tiếp thì đẩy alert lên Alertmanager
(nhãn source="aiops"), hết bất thường thì gửi endsAt=now để resolve.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from .collectors.loki import LokiClient, stream_service
from .collectors.prometheus import PrometheusClient
from .detection.logs import LogAnomalyDetector
from .detection.metrics import DERIVED, IForest, derive, score_service
from .metrics import ANOMALY_SCORE, DETECTOR_RUNS, LOG_SCORE, METRIC_SCORE
from .alerting import AlertmanagerClient, build_alert

log = logging.getLogger("aiops.engine")


@dataclass
class ServiceState:
    score: float = 0.0
    metric_score: float = 0.0
    log_score: float = 0.0
    iforest: float = 0.0
    zscore: float = 0.0
    top_features: list = field(default_factory=list)
    onset: float | None = None
    signal: list[float] = field(default_factory=list)  # zmax 20 bước gần nhất (cho RCA)
    log_findings: dict = field(default_factory=dict)


@dataclass
class Snapshot:
    ts: float
    services: dict[str, ServiceState]

    def scores(self) -> dict[str, float]:
        return {s: v.score for s, v in self.services.items()}

    def signals(self) -> dict[str, np.ndarray]:
        return {s: np.asarray(v.signal) for s, v in self.services.items() if v.signal}

    def to_dict(self) -> dict:
        return {"ts": self.ts, "services": {s: {"score": round(v.score, 4), "metric_score": round(v.metric_score, 4),
                                                "log_score": round(v.log_score, 4), "iforest": round(v.iforest, 4),
                                                "zscore": round(v.zscore, 4), "top_features": v.top_features,
                                                "onset": v.onset, "log": v.log_findings}
                                            for s, v in self.services.items()}}


class DetectorEngine:
    def __init__(self, settings, prom: PrometheusClient | None, loki: LokiClient | None = None,
                 alerts: AlertmanagerClient | None = None, clock=time.time):
        self.s = settings
        self.prom, self.loki, self.alerts, self.clock = prom, loki, alerts, clock
        d = settings.section("detection")
        self.history_min = int(d.get("history_minutes", 120))
        self.exclude_steps = int(d.get("train_exclude_minutes", 10)) * 60 // settings.step
        self.refit_s = int(d.get("refit_minutes", 15)) * 60
        self.z_window = int(d.get("z_window", 60))
        self.z_thr = float(d.get("z_threshold", 4.5))
        self.thr = float(d.get("score_threshold", 0.6))
        self.persistence = int(d.get("persistence", 2))
        self.log_weight = float(d.get("log_weight", 0.8))
        st = settings.section("static_thresholds")
        self.static_err, self.static_p95 = float(st.get("err", 0.05)), float(st.get("p95", 1.0))
        lg = settings.section("logs")
        self.log_cfg = lg
        self.logdet = LogAnomalyDetector(lg.get("error_regex", r"(?i)error")) if lg.get("enabled", True) else None
        al = settings.section("alerting")
        self.alertname = al.get("alertname", "AIOpsAnomaly")
        self.resolve_after = int(al.get("resolve_after_minutes", 5)) * 60
        self.models: dict[str, tuple[float, IForest]] = {}
        self.above: dict[str, int] = {}
        self.below: dict[str, int] = {}
        self.firing: dict[str, float] = {}  # service → startsAt
        self.snapshot: Snapshot | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()

    # ---------------------------------------------------------------- thu thập
    def fetch(self, now: float) -> dict[str, dict[str, np.ndarray]]:
        step = self.s.step
        start = now - self.history_min * 60
        window = self.s.raw.get("rate_window", "1m")
        per_service: dict[str, dict[str, np.ndarray]] = {s: {} for s in self.s.services}
        for feat, q in (self.s.raw.get("features") or {}).items():
            try:
                _, series = self.prom.range_by_label(q.format(window=window), start, now, step)
            except Exception as e:  # noqa: BLE001
                log.warning("query %s lỗi: %s", feat, e)
                continue
            for svc, arr in series.items():
                if svc in per_service:
                    per_service[svc][feat] = arr
        return per_service

    def fetch_logs(self, now: float) -> list[tuple[str, str]]:
        if not (self.loki and self.logdet):
            return []
        sel = self.log_cfg.get("selector", "{}")
        q = f'{sel} |~ `{self.log_cfg.get("error_regex", "(?i)error")}`'
        try:
            rows = self.loki.query_range(q, now - int(self.log_cfg.get("window_minutes", 2)) * 60, now,
                                         int(self.log_cfg.get("limit", 5000)))
        except Exception as e:  # noqa: BLE001
            log.warning("query Loki lỗi: %s", e)
            return []
        out = []
        for _ts, labels, line in rows:
            svc = stream_service(labels, self.log_cfg.get("service_label", "service"))
            if svc:
                out.append((svc, line))
        return out

    # ---------------------------------------------------------------- chấm điểm
    def evaluate(self, now: float | None = None, data: dict | None = None, log_lines: list | None = None) -> Snapshot:
        now = self.clock() if now is None else now
        data = self.fetch(now) if data is None else data
        lines = self.fetch_logs(now) if log_lines is None else log_lines
        findings = self.logdet.observe(lines, self.s.services) if self.logdet else {}
        out: dict[str, ServiceState] = {}
        step = self.s.step
        for svc in self.s.services:
            raw = data.get(svc) or {}
            st = ServiceState()
            core = [raw.get(k) for k in ("rps", "p95") if raw.get(k) is not None]
            if core and min(np.count_nonzero(~np.isnan(a)) for a in core) >= 30:
                T = max(len(v) for v in raw.values())
                train = slice(0, max(20, T - self.exclude_steps))
                cached = self.models.get(svc)
                model = None
                if cached and now - cached[0] < self.refit_s:
                    model = cached[1]
                else:
                    try:
                        model = IForest(random_state=0).fit(derive(raw)[train])
                        self.models[svc] = (now, model)
                    except ValueError as e:
                        log.warning("không huấn luyện được IF cho %s: %s", svc, e)
                ss = score_service(svc, raw, train, z_window=self.z_window, z_threshold=self.z_thr,
                                   static_err=self.static_err, static_p95=self.static_p95, model=model)
                st.iforest, st.zscore = float(ss.iforest[-1]), float(ss.zscore[-1])
                st.metric_score = float(ss.combined[-1])
                st.top_features = ss.top_features
                st.signal = [round(float(x), 3) for x in ss.zmax[-20:]]
                # thời điểm khởi phát ước lượng: đầu chuỗi liên tục điểm ≥ 0.3 kết thúc ở hiện tại
                comb = ss.combined
                if comb[-1] >= 0.3:
                    i = len(comb) - 1
                    while i > 0 and comb[i - 1] >= 0.3:
                        i -= 1
                    st.onset = now - (len(comb) - 1 - i) * step
            f = findings.get(svc)
            if f:
                st.log_score = f.score
                st.log_findings = {"new": f.new_templates[:3], "spikes": f.spikes[:3], "top_errors": f.top_errors[:3]}
            st.score = max(st.metric_score, self.log_weight * st.log_score)
            if st.score >= 0.3 and st.onset is None:
                st.onset = now
            ANOMALY_SCORE.labels(svc).set(st.score)
            METRIC_SCORE.labels(svc).set(st.metric_score)
            LOG_SCORE.labels(svc).set(st.log_score)
            out[svc] = st
        snap = Snapshot(now, out)
        with self._lock:
            self.snapshot = snap
        return snap

    def alert_step(self, snap: Snapshot) -> list[dict]:
        """Máy trạng thái cảnh báo có độ bền; trả về danh sách alert đã gửi."""
        sent = []
        base = self.s.public_url.rstrip("/")
        for svc, st in snap.services.items():
            if st.score >= self.thr:
                self.above[svc] = self.above.get(svc, 0) + 1
                self.below[svc] = 0
            else:
                self.below[svc] = self.below.get(svc, 0) + 1
                self.above[svc] = 0
            if self.above[svc] >= self.persistence:
                starts = self.firing.setdefault(svc, st.onset or snap.ts)
                sent.append(build_alert(self.alertname, svc, self.s.namespace, st.score, starts,
                                        snap.ts + self.resolve_after, st.top_features, f"{base}/anomalies", True,
                                        self.s.env))
            elif svc in self.firing and self.below[svc] >= self.persistence:
                starts = self.firing.pop(svc)
                sent.append(build_alert(self.alertname, svc, self.s.namespace, st.score, starts, snap.ts,
                                        st.top_features, f"{base}/anomalies", False, self.s.env))
        if sent and self.alerts:
            self.alerts.post(sent)
        return sent

    def run_once(self) -> Snapshot | None:
        try:
            snap = self.evaluate()
            self.alert_step(snap)
            DETECTOR_RUNS.labels("ok").inc()
            return snap
        except Exception as e:  # noqa: BLE001
            DETECTOR_RUNS.labels("error").inc()
            log.exception("vòng detector lỗi: %s", e)
            return None

    def latest(self, max_age: float = 120) -> Snapshot | None:
        with self._lock:
            snap = self.snapshot
        if snap and self.clock() - snap.ts <= max_age:
            return snap
        if self.prom is None:
            return snap
        return self.run_once_quiet()

    def run_once_quiet(self) -> Snapshot | None:
        try:
            return self.evaluate()
        except Exception as e:  # noqa: BLE001
            log.warning("không tính được snapshot: %s", e)
            return None

    def loop(self) -> None:
        while not self._stop.is_set():
            t0 = time.monotonic()
            self.run_once()
            interval = self.s.eval_interval_s or self.s.step
            self._stop.wait(max(1.0, interval - (time.monotonic() - t0)))

    def start(self) -> threading.Thread:
        th = threading.Thread(target=self.loop, name="aiops-detector", daemon=True)
        th.start()
        return th

    def stop(self) -> None:
        self._stop.set()


__all__ = ["DetectorEngine", "Snapshot", "ServiceState", "DERIVED"]
