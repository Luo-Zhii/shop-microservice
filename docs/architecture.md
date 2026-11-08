# ShopNow v2 — Kiến trúc & hợp đồng giữa các service

Sàn thương mại điện tử nhiều người bán (buyer / seller / admin). Mỗi service sở hữu một bounded context và
cơ sở dữ liệu riêng (database-per-service), giao tiếp đồng bộ qua HTTP/JSON (chỉ để đọc / báo giá) và
bất đồng bộ qua Kafka (mọi thay đổi trạng thái). Tài liệu này là **nguồn sự thật** cho mọi service.

## 1. Danh sách service

| Service | Cổng | Ngôn ngữ | Lưu trữ | DB / prefix |
|---|---|---|---|---|
| api-gateway | 8080 | Node/TS (Fastify) | Redis (rate limit) | — |
| identity | 8101 | Node/TS | Postgres | `identity` |
| user-profile | 8102 | Node/TS | Postgres + Redis | `user_profile` |
| seller | 8103 | Node/TS | Postgres | `seller` |
| catalog | 8104 | Node/TS | Postgres + MinIO/S3 | `catalog` |
| search | 8105 | Node/TS | OpenSearch (prod) / Postgres FTS (dev) | `search` |
| inventory | 8106 | **Go** | Postgres | `inventory` |
| cart | 8107 | Node/TS | Redis | — |
| promotion | 8108 | Node/TS | Postgres + Redis (flash sale Lua) | `promotion` |
| order | 8109 | Node/TS | Postgres | `orders` |
| payment | 8110 | Node/TS | Postgres | `payment` |
| shipping | 8111 | Node/TS | Postgres | `shipping` |
| review | 8112 | Node/TS | MongoDB | `review` |
| notification | 8113 | Node/TS | MongoDB + SMTP | `notification` |
| ai-service | 8114 | **Python** (FastAPI) | Postgres (pgvector tuỳ chọn) | `ai` |
| web | 3000 | Next.js 15 | — | — |

Mọi service đều có: `GET /healthz` (liveness), `GET /readyz` (readiness — kiểm tra DB/Kafka),
`GET /metrics` (Prometheus), trace OpenTelemetry (OTLP HTTP `OTEL_EXPORTER_OTLP_ENDPOINT`), log JSON (pino)
có `trace_id`, `span_id`, `service`.

Hạ tầng dev local (`docker compose -f deploy/compose/infra.yml up -d`):
Postgres `localhost:55432` (user `shopnow` / pass `shopnow`, mỗi service một database), Redis `56379`,
Kafka (Redpanda) `59092`, MongoDB `57017`, MinIO `59000` (console `59001`, `minioadmin/minioadmin`),
Mailpit SMTP `51025` / UI `58025`.

## 2. Quy ước chung

- **Biến môi trường chung**: `PORT`, `SERVICE_NAME`, `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`,
  `MONGO_URL`, `JWKS_URL` (mặc định `http://localhost:8101/.well-known/jwks.json`), `JWT_ISSUER`
  (`shopnow-identity`), `JWT_AUDIENCE` (`shopnow`), `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`,
  `INTERNAL_TOKEN` (bí mật dùng chung cho `/internal/*`, header `x-internal-token`).
  URL service khác: `<NAME>_URL`, ví dụ `CATALOG_URL=http://localhost:8104`.
- **Xác thực**: access token JWT RS256 do identity cấp (15 phút), claim
  `{ sub: userId, email, roles: ["buyer"|"seller"|"admin"], shopId?: string }`.
  Mọi service tự xác minh JWT qua JWKS (zero-trust), gateway cũng xác minh trước.
- **Lỗi**: `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details"?: any } }`,
  mã: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
  `INSUFFICIENT_STOCK` 409, `RATE_LIMITED` 429, `UPSTREAM_ERROR` 502, `INTERNAL` 500.
- **Phân trang**: `?page=1&pageSize=20` → `{ items: [...], page, pageSize, total }`.
- **Tiền**: số nguyên VND (`integer`), không dùng số thực.
- **ID**: UUID v7 (sắp theo thời gian) dạng chuỗi.
- **Idempotency**: các POST tạo tài nguyên quan trọng (checkout, payment) nhận header `Idempotency-Key`.
- **Route prefix qua gateway**: `/api/<service>/...` → gateway bỏ `/api/<service>` rồi chuyển tiếp.
  Ví dụ `GET /api/catalog/products/123` → catalog `GET /products/123`. `/internal/*` bị chặn ở gateway.

## 3. Sự kiện Kafka

Phong bì (CloudEvents-lite), key Kafka = `subject` (đảm bảo thứ tự theo thực thể):

```json
{ "id": "uuidv7", "type": "order.created", "source": "order", "time": "ISO-8601",
  "subject": "<entity id>", "traceparent": "00-...", "data": { } }
```

Bên ghi dùng **Transactional Outbox** (bảng `outbox` ghi cùng transaction, relay đẩy lên Kafka).
Bên đọc dùng **Inbox** (bảng `processed_events(event_id)` hoặc tương đương) để xử lý đúng một lần;
lỗi xử lý thử lại 3 lần với backoff rồi đẩy sang `<topic>.dlq`.

| Topic | Producer | Sự kiện (type) | Consumer |
|---|---|---|---|
| `identity.user.v1` | identity | `user.registered` `{userId,email,fullName}`, `user.otp_requested` `{userId,email,purpose:"verify_email"\|"reset_password",code}`, `user.role_granted` `{userId,role}` | user-profile, notification |
| `seller.shop.v1` | seller | `shop.submitted`, `shop.approved`, `shop.rejected`, `shop.suspended` — data = Shop | identity (cấp role seller + shopId), catalog (ẩn SP khi suspended), notification |
| `catalog.product.v1` | catalog | `product.upserted` (data = ProductSnapshot), `product.deleted` `{productId}` | search, inventory (đăng ký SKU), ai-service |
| `review.v1` | review | `review.created` `{reviewId,productId,shopId,userId,rating}`, `product.rating_changed` `{productId,ratingAvg,ratingCount}` | catalog, search, notification |
| `inventory.command.v1` | order | `inventory.reserve` `{reservationId:checkoutId,orderIds,items:[{skuId,qty}],ttlSeconds}`, `inventory.commit` `{reservationId}`, `inventory.release` `{reservationId,reason}`, `inventory.restock` `{reservationId,orderId,items,reason}` (hoàn kho sau khi đã commit: huỷ đơn CONFIRMED / trả hàng) | inventory |
| `inventory.event.v1` | inventory | `inventory.reserved` `{reservationId,expiresAt}`, `inventory.reserve_failed` `{reservationId,reason,skuIds}`, `inventory.committed`, `inventory.released`, `inventory.expired` `{reservationId}`, `inventory.restocked` `{reservationId,orderId}`, `stock.changed` `{skuId,available}` | order, search |
| `payment.command.v1` | order | `payment.request` `{checkoutId,buyerId,amount,method,orderIds,returnUrl}`, `payment.refund` `{checkoutId,orderId,amount,reason}` | payment |
| `payment.event.v1` | payment | `payment.created` `{paymentId,checkoutId,method,redirectUrl?}`, `payment.succeeded` `{paymentId,checkoutId,amount}`, `payment.failed` `{paymentId,checkoutId,reason}`, `payment.refunded` `{checkoutId,orderId,amount}` | order, notification |
| `order.v1` | order | `order.created`, `order.confirmed`, `order.cancelled`, `order.shipped`, `order.delivered`, `order.completed`, `order.return_requested`, `order.returned` — data = OrderSnapshot (+`reason` khi huỷ) | cart (`order.created` → xoá món đã đặt), promotion, shipping (`order.confirmed`), payment (`order.completed` → ghi có ví seller, `order.cancelled` → hoàn tiền nếu đã trả), review (`order.completed`), notification, ai-service |
| `shipping.v1` | shipping | `shipment.created` `{shipmentId,orderId,carrier,trackingCode,fee}`, `shipment.picked`, `shipment.in_transit`, `shipment.delivered`, `shipment.failed` — `{shipmentId,orderId,status,at}` | order, notification |

### Snapshot dùng chung

```ts
ProductSnapshot = { id, shopId, shopName, categoryId, categoryPath: string[], title, slug, description,
  brand?, attributes: Record<string,string>, images: string[], status: "DRAFT"|"PENDING"|"APPROVED"|"REJECTED"|"HIDDEN",
  minPrice, maxPrice, ratingAvg, ratingCount, soldCount,
  variants: [{ id: skuId, sku, options: Record<string,string>, price, compareAtPrice?, weightGrams, status: "ACTIVE"|"INACTIVE" }],
  createdAt, updatedAt }

OrderSnapshot = { id, checkoutId, buyerId, shopId, status, items: [{ skuId, productId, title, variantLabel, image?, unitPrice, qty, lineTotal }],
  subtotal, shippingFee, discount, total, paymentMethod: "COD"|"MOCK"|"VNPAY", shippingAddress: Address, createdAt }

Address = { fullName, phone, line1, ward, district, province, isDefault? }
```

## 4. Saga đặt hàng (orchestration — order service là nhạc trưởng)

```
POST /checkout (Idempotency-Key)
 1. order gọi đồng bộ: catalog /internal/skus (giá thật), shipping /quote (phí từng shop),
    promotion /quote?commit=true (khoá voucher + suất flash sale theo checkoutId)
 2. Tạo checkout + N order (tách theo shop) trạng thái PENDING  ──outbox──▶ order.created ×N,
    inventory.reserve {reservationId=checkoutId}
 3a. inventory.reserved:
      COD   → order CONFIRMED → inventory.commit, order.confirmed
      ONLINE → order AWAITING_PAYMENT → payment.request
 3b. inventory.reserve_failed → order CANCELLED(reason=OUT_OF_STOCK) → order.cancelled (promotion nhả voucher)
 4. payment.created → lưu redirectUrl vào checkout (FE poll GET /checkouts/:id)
 5a. payment.succeeded → CONFIRMED → inventory.commit, order.confirmed
 5b. payment.failed | inventory.expired | quá hạn 15' → CANCELLED → inventory.release, order.cancelled
 6. shipping nhận order.confirmed → tạo vận đơn → shipment.* → order SHIPPING / DELIVERED
 7. buyer bấm "Đã nhận" hoặc tự động sau AUTO_COMPLETE_SECONDS → COMPLETED → order.completed
    (payment ghi có ví seller trừ 5% phí sàn; review mở quyền đánh giá)
```

Máy trạng thái order:
`PENDING → AWAITING_PAYMENT → CONFIRMED → SHIPPING → DELIVERED → COMPLETED`;
`PENDING|AWAITING_PAYMENT|CONFIRMED → CANCELLED`; `DELIVERED → RETURN_REQUESTED → RETURNED|DELIVERED (từ chối)`.
Huỷ sau khi đã trả tiền online → `payment.refund`.

## 5. API chính (đường dẫn nội bộ của service, chưa có prefix gateway)

**identity**: `POST /auth/register {email,password,fullName}` → `{userId}` (gửi OTP);
`POST /auth/verify-email {email,code}`; `POST /auth/login {email,password,totp?}` → `{accessToken,refreshToken,expiresIn,user}`;
`POST /auth/refresh {refreshToken}` (xoay vòng, phát hiện dùng lại → thu hồi cả họ token);
`POST /auth/logout`; `POST /auth/forgot-password {email}`; `POST /auth/reset-password {email,code,newPassword}`;
`POST /auth/2fa/setup` → `{secret,otpauthUrl}`; `POST /auth/2fa/enable {code}`; `GET /auth/me`;
`GET /auth/google/url`, `POST /auth/google/callback {code}` (bật khi có `GOOGLE_CLIENT_ID`);
`GET /.well-known/jwks.json`; admin: `GET /admin/users`, `POST /admin/users/:id/lock`.
Seed admin: `ADMIN_EMAIL`/`ADMIN_PASSWORD` (mặc định `admin@shopnow.local` / `Admin@12345`).
Dev: `DEV_EXPOSE_OTP=true` trả `devOtp` trong response để test tự động.

**user-profile**: `GET/PUT /me/profile`, `GET/POST/PUT/DELETE /me/addresses[/:id]`,
`GET/POST/DELETE /me/wishlist[/:productId]`, `POST /me/recently-viewed {productId}`, `GET /me/recently-viewed`,
`GET /internal/addresses/:id?userId=`.

**seller**: `POST /shops` (buyer nộp hồ sơ), `GET /shops/me`, `PUT /shops/me`, `GET /shops/:idOrSlug`,
`POST /shops/:id/follow`, `DELETE /shops/:id/follow`; admin: `GET /admin/shops?status=`,
`POST /admin/shops/:id/approve`, `/reject {reason}`, `/suspend`; `GET /internal/shops/:id`.

**catalog**: `GET /categories` (cây), admin `POST/PUT/DELETE /admin/categories`;
`GET /products?shopId&categoryId&status&page`, `GET /products/:idOrSlug`;
seller: `POST /seller/products`, `PUT /seller/products/:id`, `DELETE /seller/products/:id`,
`POST /seller/products/:id/submit`, `POST /seller/uploads {contentType}` → `{uploadUrl, publicUrl}` (presigned PUT);
admin: `GET /admin/products?status=PENDING`, `POST /admin/products/:id/approve`, `/reject {reason}`;
banner: `GET /banners`, admin `POST/DELETE /admin/banners`;
`POST /internal/skus {skuIds}` → `[{skuId,productId,shopId,title,variantLabel,image,price,weightGrams,status,productStatus}]`.

**search**: `GET /search?q&categoryId&minPrice&maxPrice&rating&shopId&sort=relevance|price_asc|price_desc|newest|best_selling&page&pageSize`
→ `{items, total, facets:{categories:[{id,name,count}], priceRanges:[...] }}`; `GET /suggest?q` → `{suggestions:[]}`.
Tìm có dấu / không dấu ("ao thun" khớp "Áo thun").

**inventory** (Go): `GET /stock?skuIds=a,b` → `[{skuId,onHand,reserved,available}]`;
seller `PUT /seller/stock/:skuId {onHand}` (kiểm tra SKU thuộc shop của token); `GET /seller/stock`.

**cart**: `GET /cart` (đã đăng nhập theo userId, khách theo header `x-cart-id`),
`POST /cart/items {skuId,qty}`, `PUT /cart/items/:skuId {qty}`, `DELETE /cart/items/:skuId`,
`POST /cart/merge {guestCartId}`. Trả về nhóm theo shop, kèm giá/tồn hiện tại.

**promotion**: `GET /vouchers?shopId` (đang chạy), seller `POST/GET /seller/vouchers`, admin `POST/GET /admin/vouchers`,
admin `POST/GET /admin/flash-sales`, `GET /flash-sales/active`;
`POST /quote {checkoutId?, buyerId, shops:[{shopId, items:[{skuId,productId,price,qty}], shippingFee}], voucherCodes, commit}`
→ `{shops:[{shopId, discount, shippingDiscount, appliedVouchers, items:[{skuId,unitPrice}]}], platformDiscount, totalDiscount}`.

**order**: `POST /checkout {items:[{skuId,qty}], addressId?|shippingAddress, voucherCodes?, paymentMethod}` → `{checkoutId, status, orderIds}`;
`GET /checkouts/:id` → `{status, redirectUrl?, orders}`; `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel {reason}`,
`POST /orders/:id/confirm-received`, `POST /orders/:id/return {reason}`;
seller: `GET /seller/orders?status`, `GET /seller/stats?days=30`; admin: `GET /admin/orders`, `GET /admin/stats`,
`POST /admin/orders/:id/return/approve|reject`.

**payment**: `GET /payments/:checkoutId`, mock gateway `GET /pay/mock/:paymentId` (trang HTML) + `POST /pay/mock/:paymentId/complete {result:"success"|"fail"}`,
VNPay: `GET /pay/vnpay/return`, `GET /pay/vnpay/ipn`; seller ví: `GET /seller/wallet`, `POST /seller/payouts {amount}`;
admin: `GET /admin/payouts`, `POST /admin/payouts/:id/paid`.

**shipping**: `POST /quote {fromProvince, toProvince, weightGrams}` → `{carrier, fee, etaDays}`;
`GET /shipments/by-order/:orderId`; seller `POST /seller/shipments/:id/pick`;
carrier webhook giả lập `POST /webhooks/carrier {trackingCode,status}`; `POST /dev/shipments/:id/advance` (khi `DEV_SIMULATOR=true`).

**review**: `GET /products/:productId/reviews?rating&page`, `GET /products/:productId/summary`,
`POST /reviews {orderId,productId,rating,content,images}` (chỉ người đã mua, mỗi sản phẩm/đơn một lần),
seller `POST /seller/reviews/:id/reply {content}`, admin `POST /admin/reviews/:id/hide`.

**notification**: `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`,
`GET /notifications/stream` (SSE, `?token=` cho EventSource); email qua SMTP.

**ai-service**: `GET /recommendations/user/:userId?limit`, `GET /recommendations/product/:productId?limit`,
`POST /chat {message, history}` (chatbot CSKH, RAG trên FAQ + sản phẩm), `POST /generate/description {title, attributes}`,
`POST /moderate {text}` → `{allowed, labels, score}`, `GET /search/semantic?q`.
Nhà cung cấp LLM: `LLM_PROVIDER=none|ollama|bedrock|anthropic` (on-prem dùng Ollama, AWS dùng Bedrock);
`none` = chế độ dự phòng theo luật, vẫn chạy được không cần LLM.

**api-gateway**: định tuyến `/api/<svc>/*`, xác minh JWT, rate limit theo IP/user (Redis), CORS, `x-request-id`,
BFF: `GET /api/bff/home` (banner + flash sale + danh mục + gợi ý), `GET /api/bff/products/:idOrSlug`
(catalog + tồn kho + tóm tắt review + flash sale + gợi ý; lỗi một nguồn vẫn trả phần còn lại).

## 6. Quan sát (RED + saga)

Metric bắt buộc (nhãn `service`): `http_server_requests_seconds` (histogram, nhãn `method`,`route`,`status`),
`kafka_messages_consumed_total{topic,type,result}`, `kafka_messages_produced_total{topic}`,
`outbox_pending` (gauge), nghiệp vụ: `orders_created_total`, `orders_cancelled_total{reason}`,
`checkout_saga_duration_seconds`, `payments_total{method,result}`, `inventory_reserve_total{result}`.
