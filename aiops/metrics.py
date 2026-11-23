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
AGENT_INVESTIGATIONS = Counter("aiops_agent_investigations_total", "Số lần tác tử điều tra hoàn tất", ["mode", "action"])
AGENT_STEPS = Histogram("aiops_agent_tool_calls", "Số lần gọi công cụ mỗi lần điều tra", ["mode"],
                        buckets=(1, 2, 4, 6, 8, 12, 16, 24))
AGENT_COST_USD = Counter("aiops_agent_cost_usd_total", "Chi phí LLM cộng dồn (USD) — chia cho số điều tra = cost/task",
                         ["mode"])
GITOPS_PRS = Counter("aiops_gitops_prs_total", "PR khắc phục do tác tử đề xuất", ["action", "verdict"])
MCP_CALLS = Counter("aiops_mcp_tool_calls_total", "Lệnh gọi công cụ qua MCP", ["tool", "ok"])
LEDGER_FINDINGS = Counter("aiops_ledger_findings_total", "Phát hiện bất thường trên sổ cái kế toán", ["rule"])
CORRELATED = Counter("aiops_alerts_correlated_total", "Alert gộp vào sự cố của service liền kề (giảm bão cảnh báo)", ["service"])
FORECAST_RPS = Gauge("aiops_forecast_rps", "Đỉnh rps dự báo trong horizon (Holt-Winters) — KEDA dùng để scale trước", ["service"])
FORECAST_REPLICAS = Gauge("aiops_forecast_replicas", "Số replica tối thiểu đề xuất theo dự báo", ["service"])
DORA_VALUE = Gauge("aiops_dora_value", "Chỉ số DORA 30 ngày (tần suất: deploy/ngày; lead time, khôi phục: giây; CFR: tỉ lệ)",
                   ["metric", "environment"])
DORA_BAND = Gauge("aiops_dora_band", "Mức DORA: 0=elite 1=high 2=medium 3=low", ["metric", "environment"])
SLO_BUDGET_ETA = Gauge("aiops_slo_budget_eta_hours", "Dự báo số giờ tới khi cạn error budget (Theil–Sen 24h)", ["slo"])
VULN_OPEN = Gauge("aiops_vuln_open", "Lỗ hổng đang mở trên workload đang chạy (Trivy Operator)", ["severity"])
VULN_BREACH = Gauge("aiops_vuln_sla_breaches", "Lỗ hổng CÓ bản sửa quá hạn SLA vá (CRITICAL 7 ngày, HIGH 30 ngày)", ["severity"])
VULN_KEV = Gauge("aiops_vuln_kev_open", "Lỗ hổng đang mở nằm trong danh mục CISA KEV (đang bị khai thác ngoài thực tế)")
