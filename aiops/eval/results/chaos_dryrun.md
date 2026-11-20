# Thí nghiệm Chaos Mesh (DRY-RUN — số liệu giả lập, chỉ kiểm tra luồng)

- Số thí nghiệm: 9, phát hiện: 9 (1.0)
- MTTD: {'mean': 45.0, 'median': 45.0}
- MTTR: {'mean': 353.3, 'median': 360.0}
- Thời gian tới khi khắc phục (TTM): None
- RCA top-1: 0.778, top-3: 0.778

| Thí nghiệm | Lỗi | Gốc mong đợi | Phát hiện | Nguồn alert | MTTD (s) | RCA top-3 | Top-1 đúng | Hành động | MTTR (s) |
|---|---|---|---|---|---|---|---|---|---|
| pod-kill-order | pod-kill | order | ✓ | aiops | 45.0 | order,catalog,seller | 1 | notify/- | 360.0 |
| network-delay-payment | network-delay | payment | ✓ | aiops | 45.0 | payment,order,accounting | 1 | notify/- | 360.0 |
| http-abort-catalog | http-abort | catalog | ✓ | aiops | 45.0 | catalog,seller,search | 1 | notify/- | 360.0 |
| cpu-stress-inventory | cpu-stress | inventory | ✓ | aiops | 45.0 | inventory,order,search | 1 | notify/- | 360.0 |
| postgres-latency | db-latency | postgres | ✓ | aiops | 45.0 |  | 0 | notify/- | 360.0 |
| kafka-network-partition | network-partition | kafka | ✓ | aiops | 45.0 |  | 0 | notify/- | 300.0 |
| pod-kill-accounting | pod-kill | accounting | ✓ | aiops | 45.0 | accounting | 1 | notify/- | 360.0 |
| network-delay-warehouse | latency | warehouse | ✓ | aiops | 45.0 | warehouse,accounting | 1 | notify/- | 360.0 |
| http-abort-rum | error | catalog | ✓ | aiops | 45.0 | catalog,seller,search | 1 | notify/- | 360.0 |
