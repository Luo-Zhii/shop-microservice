# ShopNow AIOps

Service Python (FastAPI, cổng **8120**) vận hành ShopNow: phát hiện bất thường trên metric + log, tìm nguyên nhân
gốc trên đồ thị gọi giữa service, tác tử xử lý sự cố có duyệt qua ChatOps, và bộ đánh giá cho khoá luận.

```
                ┌────────────── Prometheus ───────────────┐      ┌──── Loki ────┐
                │ http_server_requests_seconds, process_*, │      │ log JSON     │
                │ kafka_messages_consumed_total{dlq},      │      │ (pino/python)│
                │ traces_service_graph_request_total       │      └──────┬───────┘
                └───────────────┬──────────────────────────┘             │
                                ▼ query_range (30s)                       ▼ query_range
   ┌─────────────── engine.DetectorEngine (mỗi 30–60s) ────────────────────────────────┐
   │ detection.metrics: IsolationForest + robust z (median/MAD)  ─┐                   │
   │ detection.logs:    Drain3 template mới / tần suất lỗi tăng  ─┴► aiops_anomaly_score│
   └───────────────┬───────────────────────────────────────────────────────────────────┘
                   │ score ≥ 0.6 trong 2 bước → POST /api/v2/alerts (source="aiops")
                   ▼
            Alertmanager ──(mọi alert warning/critical, cả PrometheusRule tĩnh)──► POST /webhooks/alertmanager
                                                                                       │
   ┌───────────────────────────── agent.Responder ─────────────────────────────────────▼─┐
   │ gom bối cảnh: snapshot điểm, metric, top log lỗi (Loki+Drain3), Deployment/Rollout   │
   │ đổi revision ≤30', pod CrashLoop/restart → rca.rank_root_causes (PageRank cá nhân hoá) │
   │ → runbook.yaml chọn hành động → tóm tắt (LLM | template) → Telegram/Slack nút Duyệt   │
   │ → /actions/{id}/approve?token=HMAC → Executor (allowlist ns+action, DRY_RUN) → audit  │
   │ → IncidentStore (SQLite | Postgres): fault_start, detected, acknowledged, mitigated,  │
   │   resolved → aiops_mttd_seconds / aiops_mttr_seconds                                   │
   └───────────────────────────────────────────────────────────────────────────────────────┘
```

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `collectors/` | `prometheus.py` (query, query_range → lưới thời gian), `loki.py`, `service_graph.py` (đồ thị từ `traces_service_graph_request_total{client,server}`, truy vấn RED dự phòng từ `traces_spanmetrics_*`, fallback đồ thị tĩnh) |
| `detection/metrics.py` | đặc trưng, robust z, IsolationForest, ngưỡng tĩnh, lọc bền vững — **dùng chung** cho vòng lặp thật và bộ đánh giá |
| `detection/logs.py` | Drain3: template lỗi mới, đột biến tần suất, gom top lỗi |
| `rca.py` | personalized PageRank kiểu MicroRCA + 2 baseline |
| `engine.py`, `alerting.py` | vòng lặp detector, gauge, đẩy alert Alertmanager API v2 |
| `agent/` | `responder.py` (điều phối), `runbook.py`, `kube.py` (inspector + backend Deployment/Argo Rollout), `executor.py`, `notifier.py`, `approval.py` (HMAC), `summarizer.py`, `store.py` |
| `llm/` | adapter `none \| ollama \| bedrock (SigV4 tự ký) \| anthropic` (bản sao từ ai-service) |
| `ci_assistant/` | `python -m aiops.ci_assistant` — phân tích log CI |
| `eval/` | `simulator.py`, `synthetic.py`, `chaos_runner.py`, `experiments.yaml`, `results/` |
| `config/aiops.yaml`, `config/runbook.yaml` | service, đồ thị tĩnh saga, PromQL, ngưỡng, luật hành động |

`aiops/aiops/__init__.py` là shim để `cd aiops && python -m aiops.<module>` (CI dùng `working-directory: aiops`)
chạy cùng mã với khi gọi từ gốc repo.

## Thuật toán

**Đặc trưng** (mỗi service, mỗi bước 30s, PromQL trong `config/aiops.yaml`): p95 độ trễ
`histogram_quantile(0.95, …http_server_requests_seconds_bucket…)`, tỉ lệ lỗi 5xx, rps, CPU, bộ nhớ, tốc độ DLQ
(`kafka_messages_consumed_total{result="dlq"}`). Biến đổi: `log1p(p95_ms)`, `err`, `log1p(rps)`,
**CPU/request** = cpu/(rps+1) (tách tăng tải hợp lệ khỏi CPU hog), `mem`, `log1p(dlq·60)`. Mỗi đặc trưng có chiều
xấu: tăng (p95, err, cpu/req, mem, dlq) hoặc giảm (rps).

**Robust z-score**: `z_t,f = d_f · (x_t,f − median_W) / max(1.4826·MAD_W, sàn_f)`, chỉ giữ phần dương
(`d_f` = ±1 là chiều xấu), W = 60 điểm (30 phút) trước t, **bỏ các điểm đã bị coi là bất thường khỏi cửa sổ**
(sự cố kéo dài không bị "học" thành bình thường). Sàn MAD theo đặc trưng phản ánh nhiễu lượng tử hoá
(DLQ là chuỗi đếm thưa: median = MAD = 0). `zmax_t = max_f z_t,f`; điểm `s_z = σ(1.5·(zmax − 4.5))`.

**IsolationForest** (scikit-learn, 64 cây, `max_samples = min(256, n)`): huấn luyện trên đoạn bình thường
(vòng lặp thật: 2 giờ gần nhất trừ 10 phút cuối, huấn luyện lại mỗi 15 phút), đầu vào là độ lệch chuẩn hoá robust
có hướng (chiều tốt cắt về 0). Điểm thô `r = −score_samples(x)`, hiệu chỉnh `s_IF = σ((r − q99.5)/(0.25·(q99.5 − q50)))`
với q là phân vị điểm thô trên tập huấn luyện → 0.5 tại phân vị 99.5% của dữ liệu bình thường.

**Ensemble AIOps** `s = max((s_IF + s_z)/2, σ(1.5·(zmax − 9)))` — nhánh thứ hai cho lệch đơn biến rất mạnh, vì cây cô lập
chỉ chia trong miền dữ liệu huấn luyện nên IF "mù" với đặc trưng hằng số/vượt miền (vd DLQ = 0 suốt tập train); log: `s = max(s_metric, 0.8 · s_log)`. Cảnh báo khi `s ≥ 0.6` trong
`k = 2` bước liên tiếp (giống `for: 1m`). Baseline so sánh: ngưỡng tĩnh `err > 5% ∨ p95 > 1s`, cùng `k = 2`.

**Log (Drain3)**: mỗi cửa sổ 2 phút, đếm dòng theo (service, template). Template lỗi chưa từng thấy (sau 3 cửa sổ
khởi động) → 0.6; đột biến `z = (c − λ)/√(λ+1)` với λ = EWMA (α=0.2) số đếm các cửa sổ trước, `z > 3 ∧ c ≥ 5` →
`σ(z − 4)`. Điểm service `1 − Π(1 − s_i)`.

**RCA** (`rca.py`): G = đồ thị gọi caller→callee (từ trace hoặc tĩnh; cạnh Kafka hệ số 0.3). Tập bất thường
A = {s : score ≥ 0.3}, ứng viên N = A ∪ callee của A. Cạnh tiến `u→v`: `w = k_e·(ε + ρ⁺(u,v))·(ε + score_v)`,
ρ⁺ = max(0, Pearson) giữa chuỗi `zmax` 10 phút gần nhất của u và v; cạnh lùi `v→u = 0.1·w`; tự vòng
`u→u = score_u·(1 − max ρ⁺ với callee bất thường)` (bất thường không được phụ thuộc nào giải thích → giữ khối
lượng = dấu hiệu gốc). Personalization ∝ score trên A, PageRank α = 0.85, điểm cuối `π_u·(ε + score_u)`.
Baseline: (a) service có điểm cao nhất, (b) PageRank thường trên đồ thị con bất thường.

**Runbook** (`config/runbook.yaml`, luật đầu tiên khớp): gốc vừa deploy (≤30', ReplicaSet mới) → `rollback`
(Argo Rollout đang canary → abort, đã xong → undo về template revision trước; Deployment → giống `kubectl rollout undo`);
CrashLoopBackOff → `restart`; pod vừa restart và đã chạy lại → `notify`; CPU/p95 cao, không deploy → `scale_up`
(+1, nâng `minReplicas` HPA nếu có, tối đa `max_replicas`); còn lại → `notify`.
An toàn: hành động cần duyệt (token `exp.HMAC-SHA256(secret, "id:decision:exp")`, TTL 2h, approve/reject khác token),
allowlist namespace + loại hành động, `DRY_RUN=true` mặc định (`AUTO_REMEDIATION=true` để thực thi), audit JSONL + bảng `audit`.

## Chỉ số

| Chỉ số | Công thức |
|---|---|
| Precision / Recall / F1 | trên từng điểm (kịch bản × service × bước sau huấn luyện): P = TP/(TP+FP), R = TP/(TP+FN), F1 = 2PR/(P+R) |
| PA-F1 | F1 sau point-adjust: một điểm đúng trong đoạn bất thường liên tục → cả đoạn tính đúng (phổ biến trong tài liệu, lạc quan hơn) |
| Event recall | tỉ lệ kịch bản lỗi có ≥ 1 đợt cảnh báo bắt đầu trên service bị ảnh hưởng trong [t0, t1 + 2 phút] |
| Báo động giả / giờ | số đợt cảnh báo bắt đầu ngoài (service bị ảnh hưởng × cửa sổ lỗi) / tổng giờ đánh giá của cả hệ thống |
| MTTD | `detected_at − fault_start` (tổng hợp: bước cảnh báo đầu − t0, tính cả lọc bền vững; thật: startsAt alert − thời điểm `kubectl apply`) |
| MTTR | `resolved_at − fault_start` (alert resolved); TTM = `mitigated_at − fault_start` (hành động thực thi thành công) |
| RCA top-k | tỉ lệ sự cố mà nguyên nhân thật nằm trong k ứng viên đầu (`aiops_rca_evaluations_total{correct}` khi chaos runner/kỹ sư gửi nguyên nhân thật) |
| Độ đúng hành động | đúng service gốc **và** đúng loại hành động mong đợi theo bối cảnh kịch bản |

## Chạy

```bash
# từ gốc repo, venv chung (.venv đã gitignore)
.venv/bin/pip install --no-cache-dir -r aiops/requirements.txt
cd aiops
../.venv/bin/python -m pytest                                  # test
../.venv/bin/python -m aiops.eval.synthetic --scenarios 30      # số liệu tổng hợp → eval/results/ (~2 phút)
../.venv/bin/python -m aiops.eval.chaos_runner --dry-run        # kiểm tra luồng thí nghiệm, không đụng cluster
../.venv/bin/python -m aiops.eval.chaos_runner --aiops-url http://aiops.shopnow.svc:8120   # thí nghiệm thật
../.venv/bin/python -m aiops.ci_assistant --log samples/ci-failure.log --context "repo/ci" --output /tmp/explain.md
PROMETHEUS_URL=http://localhost:9090 ../.venv/bin/python -m aiops serve        # service :8120
../.venv/bin/python -m aiops detect-once                         # một vòng detector, in JSON
```

`synthetic` có `--seed` (42), `--threshold` (0.6), `--persistence` (2), `--jobs` (2; kết quả không phụ thuộc số tiến trình).
`chaos_runner` đọc `eval/experiments.yaml` → manifest `../shop-gitops/platform/chaos/experiments/*.yaml`, lấy nguyên nhân
gốc mong đợi từ annotation `aiops.shopnow.io/expected-root-cause`, báo `fault_start` và nguyên nhân thật cho AIOps
(`POST /incidents/{id}/fault-start`, `/feedback`) rồi ghi `eval/results/chaos_runs.{csv,md}`.

## Biến môi trường

`PROMETHEUS_URL`, `LOKI_URL`, `ALERTMANAGER_URL`, `AIOPS_PUBLIC_URL` (đường dẫn nút duyệt), `DATABASE_URL` /
`AIOPS_DB_URL` (Postgres; mặc định SQLite `$AIOPS_DATA_DIR/aiops.db`), `DRY_RUN` (true) / `AUTO_REMEDIATION`,
`KUBE_ENABLED` (false), `APPROVAL_SECRET`, `AIOPS_WEBHOOK_TOKEN` (Bearer của Alertmanager), `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL`, `NOTIFY_ENABLED`, `LLM_PROVIDER` (+ biến của provider, xem `llm/base.py`),
`ANOMALY_EVAL_INTERVAL_SECONDS`, `DEPLOY_ENV` (nhãn `env` trên alert), `AIOPS_CONFIG`, `AIOPS_RUNBOOK`, `AUDIT_LOG`.

## API

`POST /webhooks/alertmanager` · `GET /incidents?status&service&since&limit` → `{items, total}` (mốc thời gian ISO-8601:
`fault_start, detected_at, acknowledged_at, mitigated_at, resolved_at`) · `GET /incidents/{id}` (+ `actions`, `audit`,
`timings`) · `POST /incidents/{id}/ack|resolve|fault-start|feedback` · `GET|POST /actions/{id}/approve|reject?token=` ·
`GET /anomalies` · `POST /rca` · `/healthz /readyz /metrics`.

Metric: `aiops_anomaly_score{service}`, `aiops_metric_anomaly_score`, `aiops_log_anomaly_score`,
`aiops_incidents_total{severity,root_cause}`, `aiops_incidents_open`, `aiops_mttd_seconds{source,basis}`,
`aiops_mttr_seconds{source,basis}`, `aiops_rca_evaluations_total{correct,rank}`, `aiops_actions_total{action,result}`,
`aiops_alerts_sent_total`, `aiops_detector_runs_total`, `http_server_requests_seconds{service="aiops"}`.

## Kết quả đánh giá

Xem `eval/results/synthetic_report.md` (sinh lại bằng lệnh trên; CI tải lên artifact `aiops-eval`).
Giới hạn cần nêu trong khoá luận: dữ liệu tổng hợp do chính nhóm thiết kế (mô hình lan truyền tuyến tính theo
tỉ lệ request), MTTD bị lượng tử theo bước 30s và lọc 2 bước nên sàn = 60s, MTTR tổng hợp là mô hình phân tích có
giả định ghi trong báo cáo; Kafka/Postgres chưa là nút có metric riêng nên thí nghiệm `kafka-network-partition` và
`postgres-latency` chỉ có thể quy về service bị ảnh hưởng.
