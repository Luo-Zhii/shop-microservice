---
id: RB-003
title: Sự kiện Kafka vào DLQ tăng / consumer xử lý lỗi
services: [warehouse, accounting, inventory, notification, search, ai-service]
alerts: [ShopNowKafkaDLQRising, WarehouseOutboxBacklog]
tags: [kafka, dlq, consumer, outbox, canary]
---
## Triệu chứng
`kafka_messages_consumed_total{result="dlq"}` tăng, outbox_pending tăng, dữ liệu giữa các service bắt đầu lệch.

## Chẩn đoán
Xem dashboard Kafka/DLQ: topic và loại sự kiện nào lỗi. Nếu vừa deploy consumer, canary DLQ ratio sẽ dừng rollout.
Đọc log lỗi theo type sự kiện; kiểm tra hợp đồng sự kiện (packages/contracts) có đổi schema không.

## Khắc phục
Lỗi do bản mới → rollback. Lỗi dữ liệu → sửa rồi phát lại DLQ theo lô nhỏ. Không xoá DLQ khi chưa đối soát.

## Xác minh
DLQ ngừng tăng; chạy đối soát tồn kho (warehouse ↔ inventory) và checklist khoá sổ để chắc không còn lệch.
