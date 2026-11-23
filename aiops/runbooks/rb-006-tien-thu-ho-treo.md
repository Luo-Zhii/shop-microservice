---
id: RB-006
title: Tiền thu hộ treo / COD chưa đối soát
services: [accounting, order, payment, shipping]
alerts: [EscrowFundsStale, CodUnreconciled]
tags: [accounting, escrow, cod, saga, reconcile, finance]
chaos: pod-kill-order
---
## Triệu chứng
Checkout có số dư TK 3388 > 0 quá 15 ngày; hoặc tiền COD ĐVVC giữ (TK 1388) chưa đối soát vượt ngưỡng.

## Chẩn đoán
Kế toán → Khoá sổ: checklist escrow_stale/cod_open. Đối chiếu trạng thái đơn ở order (saga dừng ở bước nào).

## Khắc phục
Đơn đã giao: chạy bước hoàn tất để quyết toán. Đơn huỷ: hoàn tiền. COD: tải bảng kê ĐVVC vào tab Đối soát.

## Xác minh
Gauge accounting_escrow_stale_checkouts về 0; checklist khoá sổ xanh trước ngày chốt kỳ.
