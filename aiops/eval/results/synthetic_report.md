# Đánh giá AIOps trên dữ liệu tổng hợp ShopNow

- Kịch bản: **30** (25 có lỗi tiêm, 5 tăng tải lành tính), 15 service × 240 bước × 30s (60 phút huấn luyện + 60 phút đánh giá), seed=42
- Ngưỡng điểm = 0.6, lọc bền vững 2 bước liên tiếp; thời gian chạy 50.3 s

## 1. Phát hiện bất thường

| Phương pháp | Precision | Recall | F1 | PA-F1 | Event recall | MTTD TB (s) | MTTD trung vị (s) | Báo động giả / giờ |
|---|---|---|---|---|---|---|---|---|
| Ngưỡng tĩnh (err>5% ∨ p95>1s) | 1.0 | 0.201 | 0.335 | 0.507 | 0.52 | 76.2 | 60 | 0.0 |
| Robust z-score (median/MAD) | 0.925 | 0.694 | 0.793 | 0.899 | 1.0 | 60 | 60 | 0.37 |
| IsolationForest | 0.241 | 0.359 | 0.288 | 0.484 | 0.92 | 83.5 | 60 | 16.33 |
| AIOps ensemble (IF + z) | 0.934 | 0.685 | 0.79 | 0.905 | 1.0 | 60 | 60 | 0.17 |

Point-wise trên (kịch bản × service × bước) sau huấn luyện; nhãn dương = service bị ảnh hưởng đáng kể trong cửa sổ lỗi. Báo động giả = đợt cảnh báo bắt đầu ngoài (service bị ảnh hưởng × [t0, t1+2 phút]), chia cho tổng giờ đánh giá của cả hệ thống.

## 2. Theo loại lỗi (event recall / MTTD trung vị / RCA)

| Lỗi | n | Recall tĩnh | Recall z | Recall IF | Recall AIOps | MTTD tĩnh (s) | MTTD AIOps (s) | RCA top-1 | RCA top-3 |
|---|---|---|---|---|---|---|---|---|---|
| cpu | 6 | 0.0 | 1.0 | 1.0 | 1.0 | None | 60.0 | 1.0 | 1.0 |
| error | 6 | 1.0 | 1.0 | 0.83 | 1.0 | 75.0 | 60.0 | 1.0 | 1.0 |
| latency | 7 | 0.14 | 1.0 | 1.0 | 1.0 | 60 | 60 | 0.86 | 1.0 |
| pod_kill | 6 | 1.0 | 1.0 | 0.83 | 1.0 | 60.0 | 60.0 | 0.83 | 1.0 |

## 3. Phân tích nguyên nhân gốc (RCA)

| Thuật toán | Top-1 (sau phát hiện) | Top-3 (sau phát hiện) | Top-1 (oracle t0+90s) | Top-3 (oracle) |
|---|---|---|---|---|
| Personalized PageRank + tương quan (đề xuất) | 0.92 | 1.0 | 0.92 | 1.0 |
| Điểm bất thường lớn nhất | 0.92 | 1.0 | 0.92 | 1.0 |
| PageRank thường trên đồ thị con | 0.44 | 0.88 | 0.44 | 0.92 |

Số kịch bản RCA: sau phát hiện = 25, oracle = 25. RCA chạy 2 phút sau cảnh báo đầu tiên, cửa sổ tín hiệu ≤ 10 phút trước đó.

## 4. Tác tử: chọn hành động & MTTR ước lượng

- Độ đúng hành động (đúng service gốc **và** đúng loại hành động theo runbook): **0.92**
- MTTR TB: AIOps **297 s** (trung vị 255) vs thủ công **496.8 s** (trung vị 540)

Giả định MTTR: gửi thông báo 15s, chờ duyệt 120s, thực thi rollback/scale/restart = 90/60/45s; chẩn đoán thủ công 900s; không có cảnh báo → người dùng báo sau 600s; MTTR bị chặn trên bởi thời điểm lỗi tự hết. Đây là mô hình phân tích, KHÔNG phải đo thật — số đo thật lấy từ `python -m aiops.eval.chaos_runner`.

File: `synthetic_summary.csv`, `synthetic_scenarios.csv`, `synthetic_rca.csv`.
