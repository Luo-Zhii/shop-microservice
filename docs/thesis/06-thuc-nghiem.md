# Chương 6 — Thực nghiệm & đánh giá

Mọi số liệu dưới đây đều lấy từ lần chạy thật trên máy dev (14 GB RAM, ổ HDD gần đầy). Mỗi mục ghi rõ lệnh để tái lập.

## 6.1. Môi trường

| Thành phần | Cấu hình |
|---|---|
| Máy | Linux 6.17, 8 vCPU, 14 GB RAM |
| Hạ tầng dev | Docker: PostgreSQL 16, Redis 7, Redpanda 24.2 (Kafka API, 512 MB), MongoDB 7, MinIO, Mailpit |
| Ứng dụng | 13 service Node 22 (bundle esbuild, chạy tiến trình node), inventory Go 1.23 (image distroless 24.6 MB), ai-service Python 3.13 |
| Kiểm thử | node:test, go test, pytest, kịch bản e2e qua gateway, k6 |

## 6.2. Kiểm thử tự động (RQ1 — tính đúng)

Lệnh: `node tools/test-report/run.mjs` → [test-report.md](test-report.md).

| Nhóm | Số test | Kết quả |
|---|---|---|
| Node/TS (platform + 13 service) | 96 | 96/96 ✅ |
| Go (inventory) | 19 | 19/19 ✅ |
| Python (ai-service 32, aiops 32) | 64 | 64/64 ✅ |
| **Tổng** | **179** | **179/179** |

Các kiểm thử nhất quán dưới tải đồng thời (trả lời RQ1):

| Thí nghiệm | Kết quả |
|---|---|
| 50 goroutine cùng giữ 1 đơn vị khi tồn kho = 10 (inventory Go) | Đúng 10 thành công, 40 bị từ chối, không âm kho, không deadlock (30 goroutine giữ x,y ngược thứ tự) |
| 200 request `/quote` đồng thời, flash sale quota 10 (promotion) | Đúng 10 được giá sale; Redis = Postgres = 10 |
| Sự kiện Kafka giao trùng (at-least-once) | Mọi consumer chỉ xử lý 1 lần (inbox `processed_events`) |
| Checkout gửi lại cùng Idempotency-Key | Trả cùng checkoutId, không tạo đơn / không khoá voucher lần 2 |

## 6.3. End-to-end toàn sàn

Kịch bản e2e (`tests/e2e/run.ts`, chạy bằng `scripts/dev.sh up && pnpm e2e`) phủ toàn bộ luồng sàn qua gateway với Kafka
thật: mở shop → duyệt → đăng sản phẩm → kho → tìm kiếm → giỏ → voucher → checkout COD (saga) → giao → hoàn tất → đánh giá
→ ví seller, cùng hai luồng bù trừ là thanh toán thất bại và đặt vượt tồn kho. **Đợt đánh giá này chưa chạy e2e** (máy dev
không đủ tài nguyên để chạy cùng lúc 15 service và các tác vụ khác). Tính đúng của từng bước saga đã được kiểm ở mức tích
hợp (mục 6.2: order 13 test gọi thẳng handler sự kiện và kiểm bảng outbox).

## 6.4. AIOps (RQ3, RQ4, RQ5)

Lệnh: `cd aiops && python -m aiops.eval.synthetic --scenarios 30` (seed 42; 30 kịch bản: 25 lỗi tiêm gồm cpu / error /
latency / pod_kill, 5 tăng tải lành tính; 15 service × 240 bước × 30 s). Báo cáo đầy đủ:
[aiops/eval/results/synthetic_report.md](../../aiops/eval/results/synthetic_report.md).

### Phát hiện bất thường (RQ3)

| Phương pháp | Precision | Recall | F1 | PA-F1 | Event recall | MTTD TB (s) | Báo động giả/giờ |
|---|---|---|---|---|---|---|---|
| Ngưỡng tĩnh (err > 5% ∨ p95 > 1 s) | 1.000 | 0.201 | 0.335 | 0.507 | 0.52 | 76.2 | 0.00 |
| Robust z-score (median/MAD) | 0.925 | 0.694 | 0.793 | 0.899 | 1.00 | 60 | 0.37 |
| IsolationForest | 0.241 | 0.359 | 0.288 | 0.484 | 0.92 | 83.5 | 16.33 |
| **AIOps ensemble (IF + z)** | **0.934** | 0.685 | 0.790 | **0.905** | **1.00** | **60** | **0.17** |

- Ngưỡng tĩnh bỏ sót **toàn bộ lỗi CPU (0/6)** và 6/7 lỗi độ trễ. Ensemble bắt đủ **25/25** sự cố, MTTD giảm từ 76 s
  xuống 60 s, và báo động giả chỉ còn 0.17 lần/giờ, ít hơn một nửa so với z-score đơn lẻ.
- MTTD 60 s là mức sàn của thiết kế: bước đo 30 s và cần 2 bước liên tiếp vượt ngưỡng mới báo. Đây là đánh đổi có chủ ý
  giữa tốc độ phát hiện và số báo động giả.
- **Hạn chế:** IsolationForest dùng một mình rất yếu (F1 0.288). Lý do là cây cô lập chỉ chia trong miền dữ liệu huấn
  luyện, nên với đặc trưng hằng số (DLQ = 0 trong suốt tập huấn luyện) hoặc giá trị vượt xa miền đó thì nó gần như
  không phân biệt được. Vì vậy cần kết hợp với z-score.

### Tìm nguyên nhân gốc (RQ4)

| Thuật toán | Top-1 | Top-3 |
|---|---|---|
| Personalized PageRank + tương quan (đề xuất) | 0.92 | 1.00 |
| Baseline: điểm bất thường lớn nhất | 0.92 | 1.00 |
| Baseline: PageRank thường | 0.44 | 0.88 |

PageRank cá nhân hoá vượt PageRank thường rất xa (Top-1 0.92 so với 0.44). Tuy nhiên trên dữ liệu tổng hợp này nó chỉ
**hoà** baseline "điểm lớn nhất", vì lỗi tiêm tập trung rõ ở một service. Ưu thế của nó được kỳ vọng xuất hiện khi lỗi lan
rộng và service gốc không có điểm cao nhất; điều này cần kiểm chứng bằng chaos thật (mục 6.6).

### Tác tử khắc phục (RQ5)

- Chọn đúng service gốc **và** đúng loại hành động theo runbook ở **92%** kịch bản.
- MTTR ước lượng: **297 s** với AIOps so với **497 s** khi chẩn đoán thủ công, tức giảm khoảng 40%. Đây là số từ mô hình
  phân tích (thông báo 15 s, chờ duyệt 120 s, thực thi 45–90 s, chẩn đoán tay 900 s), chưa phải số đo thật. Số đo thật lấy
  bằng `python -m aiops.eval.chaos_runner` trên cụm có Chaos Mesh.

## 6.5. DevSecOps (RQ2)

| Kiểm chứng | Cách đo | Kết quả |
|---|---|---|
| Manifest hợp lệ cho 4 môi trường | `make validate` (shop-gitops) | helm template 68 tổ hợp env × service; kubeconform 1027 manifest, 0 lỗi |
| Chính sách admission | `kyverno test` | 50/50 ca đúng (chặn `:latest`, root, thiếu limits/probes, privileged) |
| IaC | `terraform validate` (bootstrap, aws-dev, aws-prod, onprem); `ansible-lint` profile production | Hợp lệ; 0 lỗi lint |
| Chỉ build service thay đổi | `scripts/ci/changed-services.mjs` | Đổi `services/cart/**` → chỉ build image cart; đổi `packages/**` → build 13 service Node + web |
| Chuỗi cung ứng | SBOM SPDX + Cosign keyless + Kyverno verifyImages | Đã cấu hình; kiểm thực tế cần cụm + Rekor |
| DORA | `tools/dora/dora.py` | Tính từ lịch sử commit `environments/*/images.yaml` khi pipeline chạy trên GitHub |

## 6.6. Việc chưa đo được trên máy dev và kế hoạch

| Hạng mục | Lý do | Cách đo khi có cụm |
|---|---|---|
| Canary tự rollback | Cần Argo Rollouts + Prometheus | Deploy bản lỗi tăng 5xx, đo thời gian tới khi abort |
| Chaos thật (MTTD/MTTR đo được) | Cần Chaos Mesh | `python -m aiops.eval.chaos_runner --experiments eval/experiments.yaml` |
| Tải k6 50 req/s | Máy dev quá tải khi chạy 15 service + k6 | Chạy k6-operator trên cụm |
| Chi phí AWS | Chưa `apply` | `scripts/bootstrap-aws.sh dev`, demo xong `destroy-aws.sh` (≈ 0,42 USD/giờ) |
