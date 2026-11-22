---
id: RB-001
title: Lỗi 5xx tăng ngay sau khi triển khai
services: [catalog, order, cart, search, api-gateway, payment, inventory, promotion, review]
alerts: [ShopNowHighErrorRate, "ShopNow*AvailabilityBurn"]
tags: [deploy, rollback, canary, 5xx]
---
## Triệu chứng
Tỉ lệ 5xx của một service vượt 2–5% trong vài phút sau khi đổi image; canary có thể đã bị Argo Rollouts dừng.

## Chẩn đoán
Xem công cụ `recent_deployments` (revision, image cũ → mới) và tab Sự cố: giả thuyết "triển khai mới" có bằng chứng.
So 5xx theo `rollouts_pod_template_hash`: chỉ bản mới lỗi thì chắc chắn do thay đổi. Kiểm log lỗi lặp lại (Drain3).

## Khắc phục
Bấm "Mở PR GitOps" của bản điều tra để rollback image về tag trước (cổng xác minh chỉ cho đổi đúng dòng image).
Nếu đang trong khung đóng băng flash sale, rollback vẫn là hành động khẩn cấp được phép — ghi lý do.

## Xác minh
5xx về dưới ngưỡng 10 phút liên tục, burn rate SLO < 1, đóng sự cố và mở postmortem nếu đốt > 10% budget.
