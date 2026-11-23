---
id: RB-005
title: Phiếu lấy hàng quá hạn xuất kho (SLA giờ cắt đơn)
services: [warehouse]
alerts: [WarehousePickSlaBreach, WarehousePickBacklogRising]
tags: [warehouse, sla, cut-off, picking, operations]
chaos: network-delay-warehouse
---
## Triệu chứng
Có phiếu quá hạn xuất (đơn trước 14h phải xuất trong ngày, sau 14h trước 12h hôm sau); KPI pick_overdue tăng.

## Chẩn đoán
Tab Kho sàn → Lấy hàng: cột Hạn xuất; lọc phiếu SHORT (thiếu hàng) và vị trí bin tắc. Kiểm máy in nhãn, ca làm.

## Khắc phục
Tăng người ca chiều khi phiếu sắp hạn > 20; xử lý phiếu SHORT (nhập bổ sung hoặc huỷ dòng), báo CS các đơn trễ.

## Xác minh
warehouse_picks_overdue về 0; không còn phiếu sắp hạn dồn ứ trước giờ cắt.
