---
id: RB-008
title: Hành trình mua hàng tổng hợp hỏng / lệch giữa hai cụm
services: [api-gateway, cart, catalog, search, synthetic]
alerts: [SyntheticStepFailing, SyntheticLocationDivergence, SyntheticProbeStale, ShopNowSyntheticJourneyBurn]
tags: [synthetic, hybrid, network, ingress, journey]
---
## Triệu chứng
Robot tổng hợp báo một bước hỏng (home/search/product/giỏ), hoặc hỏng ở một cụm còn cụm kia vẫn chạy.

## Chẩn đoán
Tab SLO → Hành trình mua hàng: bước hỏng và vị trí. Hỏng một cụm → kiểm mạng/ingress/DNS hybrid trước ứng dụng.

## Khắc phục
Lỗi ứng dụng → theo RB-001/RB-002. Lỗi cụm → chuyển lưu lượng DNS sang cụm khoẻ, mở sự cố hạ tầng.

## Xác minh
Hành trình trót lọt ở cả hai cụm 10 phút; SLO synthetic-journey ngừng đốt budget.
