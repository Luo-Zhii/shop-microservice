---
id: RB-002
title: Quá tải — độ trễ p95 và CPU cao, không có deploy mới
services: [api-gateway, catalog, search, ai-service, order]
alerts: [ShopNowHighLatencyP95, CPUThrottlingHigh, AIOpsAnomaly, ShopNowCheckoutLatencyBurn]
tags: [saturation, scale, kill-switch, flash-sale, profiling]
chaos: cpu-stress-inventory
---
## Triệu chứng
p95 tăng, CPU gần limit, rps tăng (thường lúc flash sale); không có triển khai trong 60 phút.

## Chẩn đoán
Xem tab Dự báo dung lượng (đỉnh dự báo, hệ số flash sale). Gọi công cụ `cpu_profile`: một hàm tăng tỉ trọng CPU mạnh
so với hôm qua → hồi quy code chứ không phải tải; mọi hàm tăng đều → tải thật.

## Khắc phục
Service có tính năng phụ (ai-service → recommendations, search → search-suggest): tắt bằng kill switch qua PR GitOps
flags.yaml trước — được phép cả trong giờ đóng băng. Còn lại: tăng replica (PR scale_up) hoặc nâng minReplicas KEDA.

## Xác minh
p95 về dưới ngưỡng SLO; sau đỉnh tải bật lại flag (quyết định của người), cân nhắc right-sizing nếu requests quá thấp.
