# Kết luận và hướng phát triển

## 1. Kết quả đạt được so với mục tiêu

| Mục tiêu (§1.2) | Kết quả | Minh chứng |
|---|---|---|
| M1 — Sàn TMĐT microservice nhất quán | 15 service (Node, Go, Python) + web 3 cổng; saga orchestration + outbox/inbox + idempotency; không bán vượt kho / quota dưới 50–200 request đồng thời | 179/179 test; test đồng thời inventory, promotion |
| M2 — DevSecOps có cổng chặn thật | Pipeline chặn khi test lỗi, lộ secret, CVE HIGH/CRITICAL; SBOM + Cosign keyless; Kyverno verifyImages | `ci.yml`; kyverno test 50/50 |
| M3 — GitOps hybrid | Một repo cấu hình cho 4 môi trường; ApplicationSet đa cụm; canary + AnalysisTemplate; promote bằng PR | `make validate` 1027 manifest 0 lỗi |
| M4 — Quan sát hợp nhất | OTel + LGTM, trace xuyên Kafka (traceparent trong sự kiện), log có trace_id, 4 dashboard, 3 SLO burn-rate | Chart + platform/observability |
| M5 — AIOps | Ensemble: PA-F1 0.905 so với 0.507 của ngưỡng tĩnh; phát hiện 25/25 sự cố (ngưỡng tĩnh 13/25); RCA Top-1 0.92 / Top-3 1.0; chọn đúng hành động 92% | `aiops/eval/results/` |
| M6 — DORA | Công cụ + workflow tính 4 chỉ số từ lịch sử GitOps | `tools/dora` |

**Trả lời các câu hỏi nghiên cứu:**

- **RQ1** (nhất quán): đạt ở mức kiểm thử tích hợp và kiểm thử đồng thời. Chưa có kiểm chứng end-to-end khi kill pod giữa saga.
- **RQ3** (phát hiện): ensemble tốt hơn ngưỡng tĩnh rõ rệt về recall và PA-F1, trong khi báo động giả thấp (0.17 lần/giờ).
- **RQ4** (RCA): PageRank cá nhân hoá vượt PageRank thường (0.92 so với 0.44), nhưng chỉ ngang baseline "điểm lớn nhất"
  trên dữ liệu tổng hợp.
- **RQ2, RQ5**: mới có số liệu mô hình hoá (MTTR ước lượng 297 s so với 497 s). Cần chạy trên cụm thật để kết luận.

## 2. Đóng góp

1. Một hệ thống mẫu "đủ thật" (sàn nhiều người bán, saga có bù trừ, thanh toán, vận chuyển) làm nền cho nghiên cứu vận
   hành, thay cho các ứng dụng demo đơn giản.
2. Thư viện nền giúp mọi service có sẵn outbox/inbox, telemetry, tắt êm và zero-trust auth. Thêm một service mới chỉ cần
   viết nghiệp vụ.
3. Quy trình hybrid khả chuyển: cùng chart và cùng pipeline cho on-prem (Proxmox/RKE2) và AWS (EKS); khác biệt gói gọn
   trong values theo môi trường.
4. Vòng kín AIOps có người duyệt cùng bộ đánh giá tái lập được (seed cố định, thí nghiệm chaos gắn nhãn nguyên nhân).

## 3. Hạn chế

| Hạn chế | Nguyên nhân | Ảnh hưởng |
|---|---|---|
| Chưa chạy e2e liên service, tải k6 và chaos thật | Máy dev 14 GB RAM, ổ gần đầy; không có cụm/Proxmox/AWS trong đợt đánh giá | RQ1 end-to-end, RQ2, RQ5 mới có số liệu mô hình |
| AIOps đánh giá chủ yếu trên dữ liệu tổng hợp | Chưa có dữ liệu vận hành thật | Kết quả có thể lạc quan hơn thực tế |
| RCA chưa có nút hạ tầng (Kafka, Postgres) | Đồ thị chỉ gồm service | Lỗi ở broker/DB chỉ quy được về service bị ảnh hưởng |
| IsolationForest đơn lẻ yếu (F1 0.288) | Không ngoại suy ngoài miền dữ liệu huấn luyện | Phải ghép với z-score |
| Refresh token lưu localStorage | Đơn giản hoá phía web | Nên chuyển sang cookie httpOnly do gateway đặt |
| Giá trị môi trường thật còn `REPLACE-ME` | Chưa `terraform apply` | Phải điền từ output Terraform trước khi đồng bộ prod |

## 4. Hướng phát triển

1. Chạy đủ bộ thí nghiệm chaos trên cụm kind/RKE2 để đo **MTTD/MTTR thật**. So sánh ba chế độ: thủ công, AIOps chỉ
   cảnh báo, AIOps có hành động.
2. Thêm nút hạ tầng (Kafka, Postgres, Redis) vào đồ thị RCA, thử thuật toán dựa trên trace (TraceRCA) và mô hình nhân quả.
3. Thay IsolationForest bằng mô hình chuỗi thời gian nhẹ (LSTM-autoencoder, USAD) chạy CPU, rồi so sánh trên cùng bộ eval.
4. Dự báo tải (Prophet) để KEDA scale trước giờ flash sale (predictive autoscaling).
5. Bổ sung chat người mua – người bán, CDC (Debezium) thay cho outbox polling, đa vùng active-passive cho prod-aws.
6. Đo DORA thực trong 4–8 tuần vận hành pipeline trên GitHub.
