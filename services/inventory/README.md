# inventory (Go)

Tồn kho + giữ hàng cho saga đặt hàng của ShopNow v2. Hợp đồng: `docs/architecture.md` (§3 sự kiện, §4 saga, §5 API, §6 metric).
Cổng `8106`, database Postgres `inventory` (tự tạo khi chạy dev).

## Cấu trúc

| Package | Vai trò |
|---|---|
| `cmd/inventory` | main: nạp config, migrate, chạy HTTP + consumer + relay outbox + sweeper, tắt êm SIGTERM ≤ 15s |
| `internal/inventory` | nghiệp vụ: đăng ký SKU từ catalog, reserve / commit / release, sweeper hết hạn, chỉnh tồn của seller |
| `internal/events` | phong bì sự kiện, Transactional Outbox + relay (`FOR UPDATE SKIP LOCKED`), Inbox `processed_events` |
| `internal/kafka` | franz-go: producer (gzip để kafkajs đọc được), consumer group, thử lại 3 lần → `<topic>.dlq` |
| `internal/httpapi` | chi router, JWT seller, lỗi `{error:{code,message}}`, `/healthz` `/readyz` `/metrics` |
| `internal/auth` | JWT RS256 qua JWKS (keyfunc v3), iss `shopnow-identity`, aud `shopnow` |
| `internal/db` | pgxpool, tự tạo database, migration nhúng `go:embed` có advisory lock |
| `internal/telemetry` | OpenTelemetry OTLP HTTP, W3C `traceparent`, log `slog` JSON có `trace_id`/`span_id` |

## Sự kiện

- Nhận `catalog.product.v1`: `product.upserted` → đăng ký/cập nhật SKU (`active` theo trạng thái variant; variant bị bỏ → inactive), tạo `stock` = 0 nếu mới; `product.deleted` → mọi SKU của sản phẩm inactive.
- Nhận `inventory.command.v1` (idempotent qua inbox):
  - `inventory.reserve` → một transaction, giữ tất cả hoặc không món nào, khoá dòng theo thứ tự `sku_id` → `inventory.reserved {reservationId, expiresAt}` hoặc `inventory.reserve_failed {reservationId, reason:"OUT_OF_STOCK"|"INVALID_REQUEST", skuIds}`. Gửi lại cùng `reservationId` → phát lại đúng kết quả cũ.
  - `inventory.commit` → `on_hand -= qty`, `reserved -= qty`, ghi `stock_movements` → `inventory.committed`.
  - `inventory.release` → nhả nếu còn `RESERVED` → `inventory.released`.
  - `inventory.restock {reservationId, orderId, items:[{skuId,qty}], reason:"BUYER_CANCELLED"|"RETURNED"}` → chỉ cho reservation `COMMITTED`: `on_hand += qty`, ghi `stock_movements` (`RESTOCK_<reason>`, ref `reservationId/orderId`) → `inventory.restocked {reservationId, orderId}`. Idempotent theo `(reservationId, orderId)`; tổng số trả mỗi SKU không vượt số đã commit (vượt / sai trạng thái → DLQ).
- Sweeper: `RESERVED` quá `expires_at` → `EXPIRED`, nhả hàng → `inventory.expired` (an toàn nhiều replica).
- Mọi thay đổi tồn → `stock.changed {skuId, available}`. Tất cả phát qua outbox lên `inventory.event.v1`, key = `reservationId` hoặc `skuId`.

## REST

- `GET /stock?skuIds=a,b` (công khai, tối đa 200) → `[{skuId,onHand,reserved,available}]` (SKU không tồn tại bị bỏ qua).
- `GET /seller/stock?page&pageSize&productId` (seller có `shopId`) → `{items,page,pageSize,total}`.
- `PUT /seller/stock/:skuId {onHand}` → SKU phải thuộc shop trong token (`403 FORBIDDEN`), `onHand ≥ reserved` (`409 INSUFFICIENT_STOCK`).

## Cấu hình (env)

`PORT` (8106), `DATABASE_URL` (`postgres://shopnow:shopnow@localhost:55432/inventory`), `KAFKA_BROKERS` (`localhost:59092`),
`KAFKA_ENABLED` (true), `JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `INTERNAL_TOKEN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`,
`RESERVATION_DEFAULT_TTL_SECONDS` (900), `RESERVATION_SWEEP_INTERVAL_MS` (2000), `OUTBOX_RELAY_INTERVAL_MS` (250).

## Lệnh (không cần cài Go — chạy trong docker)

```sh
make test    # go test ./... với TEST_DATABASE_URL=postgres://shopnow:shopnow@localhost:55432/inventory_test
make lint    # gofmt + go vet
make build   # bin/inventory (CGO_ENABLED=0, -trimpath, -s -w)
make image   # docker build -t shopnow/inventory:dev .  (distroless static, nonroot)
```
