"""Metric Prometheus của chính AIOps."""

from prometheus_client import Counter, Gauge, Histogram

DURATION_BUCKETS = (15, 30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200)

ANOMALY_SCORE = Gauge("aiops_anomaly_score", "Điểm bất thường tổng hợp [0..1] mỗi service", ["service"])
METRIC_SCORE = Gauge("aiops_metric_anomaly_score", "Điểm bất thường từ metric (IF + robust z)", ["service"])
LOG_SCORE = Gauge("aiops_log_anomaly_score", "Điểm bất thường từ log (Drain3)", ["service"])
DETECTOR_RUNS = Counter("aiops_detector_runs_total", "Số vòng chạy detector", ["result"])
ALERTS_SENT = Counter("aiops_alerts_sent_total", "Số alert đẩy lên Alertmanager", ["state"])
INCIDENTS = Counter("aiops_incidents_total", "Số sự cố (đếm sau khi điều tra, nhãn = nguyên nhân gốc top-1)",
                    ["severity", "root_cause"])
INCIDENTS_OPEN = Gauge("aiops_incidents_open", "Số sự cố chưa resolved")
RCA_EVALUATIONS = Counter("aiops_rca_evaluations_total", "Đánh giá RCA khi biết nguyên nhân thật (chaos/feedback)",
                          ["correct", "rank"])
MTTD = Histogram("aiops_mttd_seconds", "Thời gian từ khi lỗi bắt đầu đến khi phát hiện (basis = nguồn mốc fault_start)",
                 ["source", "basis"], buckets=DURATION_BUCKETS)
MTTR = Histogram("aiops_mttr_seconds", "Thời gian từ khi lỗi bắt đầu (hoặc phát hiện) đến khi khôi phục",
                 ["source", "basis"], buckets=DURATION_BUCKETS)
ACTIONS = Counter("aiops_actions_total", "Hành động khắc phục", ["action", "result"])
HTTP_DURATION = Histogram("http_server_requests_seconds", "Thời gian xử lý HTTP (RED)",
                          ["service", "method", "route", "status"],
                          buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10))
