---
id: RB-004
title: Lệch tồn kho giữa kho sàn và tồn để bán (nguy cơ bán vượt tồn)
services: [warehouse, inventory]
alerts: [StockDriftOversellRisk, StockDriftUndersell, StockReconcileStale]
tags: [inventory, warehouse, reconcile, oversell, data-consistency]
chaos: kafka-network-partition
---
## Triệu chứng
Đối soát báo SKU lệch bền vững; loại "bán vượt tồn" = inventory nhiều hơn hàng thật trong kho.

## Chẩn đoán
Tab Kho sàn → Đối soát tồn: SKU, độ lệch, loại. Kiểm consumer warehouse.stock_changed của inventory (DLQ, lag).
"Chưa có ở inventory" thường do SKU chưa đăng ký ở catalog.

## Khắc phục
Admin bấm "Đồng bộ lại" — warehouse phát lại sự kiện tồn qua outbox, inventory tự sửa theo consumer chuẩn. Không sửa
thẳng DB của service khác. Tạm ẩn SKU bán vượt tồn nếu đang có đơn chờ.

## Xác minh
Lần đối soát kế tiếp không còn lệch bền vững; gauge warehouse_stock_drift_skus về 0.
