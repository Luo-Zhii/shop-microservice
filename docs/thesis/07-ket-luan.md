# Kết luận và hướng phát triển

## 1. Kết quả đạt được so với mục tiêu

| Mục tiêu (§1.2) | Kết quả | Minh chứng |
|---|---|---|
| M1 — Sàn TMĐT microservice nhất quán | 17 service (Node, Go, Python; thêm kế toán và kho ở chương 8) + web 3 cổng; saga orchestration + outbox/inbox + idempotency; không bán vượt kho / quota dưới 50–200 request đồng thời | 250 test tự động (179 ở chương 5 + 71 ở chương 8; kiểm hồi quy toàn bộ 22/11 được 240, sau đó thêm 10); test đồng thời inventory, promotion |
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

**Kết quả của phần mở rộng (chương 8):**

| Hướng | Kết quả | Mục |
|---|---|---|
| Tác tử điều tra (agentic RCA) qua MCP | Planner tất định: top-1 0.92, hành động đúng 0.92 trên 25 kịch bản. Lọc grounding chặn 11/11 kết luận bịa của LLM giả lập; tắt lọc thì lọt 11/11 | 8.2, 8.10 |
| Gom cảnh báo theo topology | Số sự cố 62 → 28 (−54.8%); service gốc nằm trong sự cố chính 25/25 | 8.15 |
| KPI kinh doanh/UX có hướng | Bắt được "HTTP 200 nhưng không ai đặt được đơn" và LCP xấu, điều mà 6 đặc trưng hạ tầng bỏ sót | 8.20 |
| Dự báo dung lượng + flash sale | Holt-Winters sai 2.3% ở đỉnh (giữ mức hiện tại sai 14%); học được hệ số flash sale ≈ 3 → KEDA scale trước | 8.21, 8.22 |
| Change management | Chấm rủi ro từ diff + chính sách error budget → nhãn PR và cấu hình canary | 8.13 |
| DevSecOps chuỗi cung ứng | SLSA provenance, OpenVEX, Scorecard, Kyverno kiểm attestation (Audit), canary có cổng AIOps | 8.6, 8.12 |
| Workload doanh nghiệp | Sổ cái kép bất biến có chuỗi hash, khoá sổ + checklist sẵn sàng, GTGT, tuổi nợ, đối soát COD/cổng TT; kho FIFO, kiểm kê mù four-eyes, ABC, đề xuất nhập | 8.3–8.4, 8.11–8.18, 8.27 |
| Sự cố "câm" (HTTP 200 nhưng người dùng bị ảnh hưởng) | Detector hạ tầng bắt **0/80**; thêm KPI có hướng + CUSUM bắt **80/80**, 0 báo động giả trên 40 đối chứng (kiểm 4 seed) | 8.20, 8.24, 8.25 |
| Quan sát chính tác tử | Trace theo OTel GenAI semconv (invoke_agent / chat / execute_tool, tool.call.id = evidence id) | 8.23 |
| Dự báo dung lượng | Thêm mùa vụ tuần: sáng thứ Bảy MAE 26.9 → 4.1 rps | 8.28 |
| Platform engineering | Scorecard 11 luật chấm từ repo: lần đầu Gold 2 / Silver 2 / Bronze 13 → sau khi sửa luật + thêm SLO: Gold 2 / Silver 14 / Bronze 1 | 8.30 |
| Vận hành SRE | Tìm sự cố tương tự, chất lượng cảnh báo (ồn / hạ ticket / giữ), tab SLO, bàn giao ca | 8.26, 8.29, 8.31 |

## 2. Đóng góp

1. Một hệ thống mẫu "đủ thật" (sàn nhiều người bán, saga có bù trừ, thanh toán, vận chuyển) làm nền cho nghiên cứu vận
   hành, thay cho các ứng dụng demo đơn giản.
2. Thư viện nền giúp mọi service có sẵn outbox/inbox, telemetry, tắt êm và zero-trust auth. Thêm một service mới chỉ cần
   viết nghiệp vụ.
3. Quy trình hybrid khả chuyển: cùng chart và cùng pipeline cho on-prem (Proxmox/RKE2) và AWS (EKS); khác biệt gói gọn
   trong values theo môi trường.
4. Vòng kín AIOps có người duyệt cùng bộ đánh giá tái lập được (seed cố định, thí nghiệm chaos gắn nhãn nguyên nhân).
5. Tác tử AIOps "có căn cứ": mọi kết luận phải trích bằng chứng sinh từ công cụ; giới hạn an toàn viết trong code thay vì
   prompt; khắc phục chỉ đi qua PR GitOps có cổng xác minh diff. Thiết kế này đo được bằng ablation (mục 8.10).
6. AIOps vượt ra ngoài hạ tầng: dùng cùng một khung để phát hiện bất thường trên KPI kinh doanh, dữ liệu kế toán (Benford,
   chi trùng) và rủi ro thay đổi, đồng thời nối dự báo với autoscaling.

## 3. Hạn chế

| Hạn chế | Nguyên nhân | Ảnh hưởng |
|---|---|---|
| Chưa chạy e2e liên service, tải k6 và chaos thật | Máy dev 14 GB RAM, ổ gần đầy; không có cụm/Proxmox/AWS trong đợt đánh giá | RQ1 end-to-end, RQ2, RQ5 mới có số liệu mô hình |
| AIOps đánh giá chủ yếu trên dữ liệu tổng hợp | Chưa có dữ liệu vận hành thật | Kết quả có thể lạc quan hơn thực tế |
| RCA chưa có nút hạ tầng (Kafka, Postgres) | Đồ thị chỉ gồm service | Lỗi ở broker/DB chỉ quy được về service bị ảnh hưởng |
| IsolationForest đơn lẻ yếu (F1 0.288) | Không ngoại suy ngoài miền dữ liệu huấn luyện | Phải ghép với z-score |
| Refresh token lưu localStorage | Đơn giản hoá phía web | Nên chuyển sang cookie httpOnly do gateway đặt |
| Giá trị môi trường thật còn `REPLACE-ME` | Chưa `terraform apply` | Phải điền từ output Terraform trước khi đồng bộ prod |
| Tác tử LLM mới đo bằng LLM giả lập | Không dùng API LLM trả phí trong đợt đánh giá | Mục 8.10 chứng minh bộ lọc grounding, chưa đo năng lực LLM thật |
| Dự báo dung lượng, KPI, gom cảnh báo đo trên dữ liệu tổng hợp | Như trên: chưa có cụm và lưu lượng thật | Cần kiểm lại khi có Prometheus thật; chưa có mùa vụ tuần |
| Trọng số chấm rủi ro thay đổi là prior do người đặt | Chưa có lịch sử deploy → sự cố để học | `fit()` sẵn sàng khi có dữ liệu |
| Workflow mới (SLSA, Scorecard, change-risk, scorecard job) và policy attestation chưa chạy trên GitHub/cụm thật | Như hàng đầu | Mới kiểm cú pháp, render và test cục bộ |
| CUSUM và ngưỡng KPI hiệu chỉnh trên nhiễu độc lập | Dữ liệu tổng hợp | Metric thật tự tương quan → cần chọn h theo ARL₀ trên dữ liệu thật |

## 4. Hướng phát triển

1. Chạy đủ bộ thí nghiệm chaos trên cụm kind/RKE2 để đo **MTTD/MTTR thật**. So sánh ba chế độ: thủ công, AIOps chỉ
   cảnh báo, AIOps có hành động.
2. Thêm nút hạ tầng (Kafka, Postgres, Redis) vào đồ thị RCA, thử thuật toán dựa trên trace (TraceRCA) và mô hình nhân quả.
3. Thay IsolationForest bằng mô hình chuỗi thời gian nhẹ (LSTM-autoencoder, USAD) chạy CPU, rồi so sánh trên cùng bộ eval.
4. ~~Dự báo tải để KEDA scale trước giờ flash sale~~: đã làm ở mục 8.21–8.22 (Holt-Winters + lịch flash sale). Còn lại:
   mùa vụ tuần, và so sánh với Prophet/N-BEATS trên dữ liệu thật.
5. Bổ sung chat người mua – người bán, CDC (Debezium) thay cho outbox polling, đa vùng active-passive cho prod-aws.
6. Đo DORA thực trong 4–8 tuần vận hành pipeline trên GitHub.
7. Đánh giá tác tử với LLM thật (Claude, Ollama) trên benchmark công khai (Cloud-OpsBench, AIOpsLab), đo chi phí trên
   mỗi lần điều tra hoàn tất và tỉ lệ kết luận bị loại vì không có bằng chứng.
8. Học trọng số chấm rủi ro thay đổi từ lịch sử deploy thật; chuyển policy attestation của Kyverno từ Audit sang Enforce.
