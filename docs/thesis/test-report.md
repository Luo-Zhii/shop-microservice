# Báo cáo kiểm thử tự động

Sinh tự động bởi `tools/test-report/run.mjs` lúc 2026-11-08T12:42:53.155Z trên máy dev.

**Tổng: 96/96 test đạt** (14 bộ test, chạy tuần tự).

| Bộ test | Ngôn ngữ | Đạt | Tổng | Thời gian | Kết quả |
|---|---|---|---|---|---|
| packages/platform | Node/TS | 3 | 3 | 0.9s | ✅ |
| services/api-gateway | Node/TS | 9 | 9 | 43.3s | ✅ |
| services/cart | Node/TS | 6 | 6 | 2.9s | ✅ |
| services/catalog | Node/TS | 2 | 2 | 94.3s | ✅ |
| services/identity | Node/TS | 11 | 11 | 190.0s | ✅ |
| services/notification | Node/TS | 7 | 7 | 57.4s | ✅ |
| services/order | Node/TS | 13 | 13 | 136.4s | ✅ |
| services/payment | Node/TS | 6 | 6 | 81.1s | ✅ |
| services/promotion | Node/TS | 9 | 9 | 122.0s | ✅ |
| services/review | Node/TS | 4 | 4 | 94.8s | ✅ |
| services/search | Node/TS | 12 | 12 | 50.9s | ✅ |
| services/seller | Node/TS | 3 | 3 | 133.1s | ✅ |
| services/shipping | Node/TS | 6 | 6 | 27.8s | ✅ |
| services/user-profile | Node/TS | 5 | 5 | 100.4s | ✅ |

## packages/platform

| # | Test | Kết quả |
|---|---|---|
| 1 | slugify bỏ dấu tiếng Việt | ✅ |
| 2 | parsePage giới hạn pageSize | ✅ |
| 3 | newId là uuid v7 | ✅ |

## services/api-gateway

| # | Test | Kết quả |
|---|---|---|
| 1 | proxy bỏ prefix /api/<svc>, giữ query, truyền x-request-id, không tin x-user-id client gửi | ✅ |
| 2 | chặn mọi đường /internal (kể cả mã hoá / dot-segment) | ✅ |
| 3 | JWT: token hợp lệ → x-user-id; token sai → 401; endpoint đăng nhập/refresh bỏ qua token cũ | ✅ |
| 4 | BFF product: gom catalog + review + flash sale; inventory/ai chết → degraded | ✅ |
| 5 | BFF home: thiếu nguồn phụ vẫn trả; catalog chết → lỗi UPSTREAM_ERROR | ✅ |
| 6 | rate limit: /api/identity/auth/* 30 req/phút/IP → RATE_LIMITED; IP khác không ảnh hưởng | ✅ |
| 7 | rate limit lưu Redis (dùng chung giữa các replica) | ✅ |
| 8 | SSE đi xuyên proxy không bị buffer, ?token= được xác minh | ✅ |
| 9 | /api/status gom readyz của các upstream | ✅ |

## services/cart

| # | Test | Kết quả |
|---|---|---|
| 1 | khách thêm giỏ → nhận x-cart-id, nhóm theo shop, tính tiền | ✅ |
| 2 | validate: qty 0, sku không tồn tại, hết hàng, giỏ rỗng | ✅ |
| 3 | inventory chết → available=null, không lỗi; đổi giá + hết hàng có cảnh báo | ✅ |
| 4 | merge giỏ khách vào giỏ user: cộng dồn rồi xoá giỏ khách | ✅ |
| 5 | giới hạn 100 dòng | ✅ |
| 6 | order.created → xoá SKU đã đặt khỏi giỏ buyer, idempotent | ✅ |

## services/catalog

| # | Test | Kết quả |
|---|---|---|
| 1 | seller tạo sản phẩm → admin duyệt → công khai + outbox có sự kiện | ✅ |
| 2 | validate dữ liệu: giá âm / SKU trùng | ✅ |

## services/identity

| # | Test | Kết quả |
|---|---|---|
| 1 | đăng ký → OTP sai 5 lần bị khoá → gửi lại → xác thực → đăng nhập, JWT RS256 hợp lệ qua JWKS | ✅ |
| 2 | refresh xoay vòng; dùng lại token cũ → thu hồi cả family | ✅ |
| 3 | sai mật khẩu 5 lần → khoá 15 phút, mật khẩu đúng cũng bị chặn | ✅ |
| 4 | quên mật khẩu → OTP → đặt lại, phiên cũ bị thu hồi | ✅ |
| 5 | 2FA TOTP: setup → enable → đăng nhập bắt buộc mã, không dùng lại mã cũ | ✅ |
| 6 | consumer shop.approved → role seller + shopId (idempotent); shop.suspended → thu role | ✅ |
| 7 | admin: liệt kê / tìm user, khoá & mở khoá; buyer bị 403; /internal/users | ✅ |
| 8 | Google OAuth: url + callback tạo user mới, lần 2 đăng nhập cùng tài khoản | ✅ |
| 9 | khoá ký được lưu DB: nạp lại vẫn cùng kid | ✅ |
| 10 | base32 mã hoá/giải mã khứ hồi | ✅ |
| 11 | HOTP/TOTP khớp vector RFC 4226 / RFC 6238 (SHA1) | ✅ |

## services/notification

| # | Test | Kết quả |
|---|---|---|
| 1 | OTP + chào mừng → email (template tiếng Việt), không gửi trùng | ✅ |
| 2 | order.created → buyer in-app + email, seller in-app (cache chủ shop); huỷ có lý do tiếng Việt | ✅ |
| 3 | payment.* (tra buyer theo checkout) + shipment.created (mã vận đơn) + shop.approved | ✅ |
| 4 | API in-app: phân trang, unreadCount, đọc 1 / đọc hết, không đọc được của người khác | ✅ |
| 5 | SSE: token qua ?token=, nhận ready + heartbeat + thông báo mới | ✅ |
| 6 | fan-out nhiều replica qua Redis pub/sub | ✅ |
| 7 | SMTP thật (Mailpit) gửi được email | ✅ |

## services/order

| # | Test | Kết quả |
|---|---|---|
| 1 | COD happy path: tách đơn theo shop, tính tiền, giữ kho → CONFIRMED → giao → hoàn tất | ✅ |
| 2 | thanh toán online happy path: AWAITING_PAYMENT → payment.request → redirectUrl → CONFIRMED | ✅ |
| 3 | hết hàng: reserve_failed → CANCELLED(OUT_OF_STOCK), không nhả kho | ✅ |
| 4 | thanh toán thất bại → CANCELLED(PAYMENT_FAILED) + inventory.release | ✅ |
| 5 | quá hạn thanh toán: sweeper với thời gian giả → CANCELLED(PAYMENT_TIMEOUT) + release; tiền về muộn → hoàn | ✅ |
| 6 | inventory.expired khi đang chờ thanh toán → CANCELLED(PAYMENT_TIMEOUT) | ✅ |
| 7 | huỷ sau khi đã trả online → order.cancelled + payment.refund đúng một lần | ✅ |
| 8 | huỷ khi đang chờ thanh toán → huỷ cả checkout + nhả kho, không hoàn tiền | ✅ |
| 9 | trả hàng: yêu cầu trong 7 ngày → admin duyệt → RETURNED + payment.refund; từ chối → DELIVERED; quá hạn → 409 | ✅ |
| 10 | sweeper tự hoàn tất đơn DELIVERED quá AUTO_COMPLETE_SECONDS | ✅ |
| 11 | idempotency checkout: cùng key + cùng user → kết quả cũ; khác body → 409; user khác dùng được key đó | ✅ |
| 12 | sự kiện trùng (Kafka at-least-once) không xử lý 2 lần | ✅ |
| 13 | validate: chưa đăng nhập 401, SKU ngừng bán 400, thiếu địa chỉ 400, admin stats | ✅ |

## services/payment

| # | Test | Kết quả |
|---|---|---|
| 1 | MOCK: payment.request idempotent → trang mock → thành công → payment.succeeded + redirect returnUrl | ✅ |
| 2 | MOCK thất bại → payment.failed | ✅ |
| 3 | VNPay: URL ký HMAC-SHA512 đúng chuẩn 2.1.0; IPN verify chữ ký, idempotent, đúng RspCode | ✅ |
| 4 | COD → PENDING_COD không redirect; đơn 0đ online → thành công ngay | ✅ |
| 5 | hoàn tiền đúng 1 lần theo orderId (payment.refund lặp + order.cancelled); chưa trả thì không hoàn | ✅ |
| 6 | order.completed → ghi có ví seller (trừ ship + 5% phí sàn), đúng 1 lần; rút tiền + admin chi trả | ✅ |

## services/promotion

| # | Test | Kết quả |
|---|---|---|
| 1 | chia tỉ lệ số nguyên: tổng luôn đúng | ✅ |
| 2 | 200 lệnh giữ suất flash sale đồng thời, quota 10 → đúng 10 thành công (qua /quote commit=true) | ✅ |
| 3 | Lua giữ suất trực tiếp: 200 lệnh đồng thời, quota 10, perUserLimit 2 | ✅ |
| 4 | perUserLimit flash sale + quote idempotent theo checkoutId + nhả suất khi order.cancelled | ✅ |
| 5 | voucher: shop PERCENT có trần, sàn FIXED chia tỉ lệ, FREESHIP; commit=false không khoá | ✅ |
| 6 | voucher sàn chỉ được nhả khi huỷ vì OUT_OF_STOCK / PAYMENT_FAILED / PAYMENT_TIMEOUT | ✅ |
| 7 | voucher không hợp lệ → VALIDATION_ERROR rõ ràng; usageLimit không vượt khi đồng thời | ✅ |
| 8 | CRUD voucher: phân quyền seller/admin, GET /vouchers?shopId, xoá voucher đã dùng → tắt | ✅ |
| 9 | sweeper nhả voucher LOCKED bị bỏ quên sau TTL; order.confirmed tới muộn vẫn chuyển USED | ✅ |

## services/review

| # | Test | Kết quả |
|---|---|---|
| 1 | chỉ người đã mua mới được đánh giá; mỗi (order, product) một lần; validate | ✅ |
| 2 | kiểm duyệt: AI chặn → HIDDEN; AI chết → fail-open PUBLISHED; tổng hợp sao + lọc | ✅ |
| 3 | seller trả lời review của shop mình | ✅ |
| 4 | outbox: crash sau khi ghi review → sweeper chuyển lại, relay gửi đúng thứ tự rồi xoá | ✅ |

## services/search

| # | Test | Kết quả |
|---|---|---|
| 1 | mapping: analyzer asciifolding + edge_ngram cho suggest | ✅ |
| 2 | toIndexDoc: categoryFacet "id\|tên" song song chuỗi danh mục | ✅ |
| 3 | buildSearchBody: bool fuzzy + filter + post_filter giá + aggs + sort + phân trang | ✅ |
| 4 | buildSearchBody: không có q → match_all, sort theo hợp đồng | ✅ |
| 5 | buildSuggestBodies: edge_ngram trên title.suggest + truy vấn phổ biến | ✅ |
| 6 | parseSearchResponse: hits + facets | ✅ |
| 7 | tìm có dấu / không dấu / sai chính tả nhẹ | ✅ |
| 8 | lọc danh mục cha/con, giá, rating, shop + sắp xếp + phân trang | ✅ |
| 9 | facets danh mục + khoảng giá | ✅ |
| 10 | chỉ APPROVED được index; product.deleted xoá; bản cũ đến trễ bị bỏ qua; rating_changed | ✅ |
| 11 | stock.changed → inStock theo product (kể cả khi tồn đến trước sản phẩm) | ✅ |
| 12 | suggest: tiền tố tiêu đề + truy vấn phổ biến | ✅ |

## services/seller

| # | Test | Kết quả |
|---|---|---|
| 1 | mở shop: KYC che + mã hoá, slug từ tên, mỗi user 1 shop, shop.submitted | ✅ |
| 2 | buyer không duyệt được; admin từ chối (lý do) → sửa → nộp lại → duyệt → khoá → mở lại | ✅ |
| 3 | theo dõi shop: followerCount, idempotent, không tự theo dõi, shop chưa duyệt → 404 | ✅ |

## services/shipping

| # | Test | Kết quả |
|---|---|---|
| 1 | bảng tỉnh: đủ 63, so khớp không dấu & viết tắt | ✅ |
| 2 | phí chuẩn theo vùng + cân nặng; chọn hãng rẻ nhất | ✅ |
| 3 | POST /quote theo hợp đồng + lỗi tỉnh lạ | ✅ |
| 4 | order.confirmed → vận đơn + shipment.created (idempotent); seller pick; webhook HMAC; mô phỏng tới DELIVERED | ✅ |
| 5 | webhook nhảy cóc CREATED → DELIVERED vẫn phát đủ sự kiện trung gian | ✅ |
| 6 | order.cancelled: huỷ khi chưa lấy hàng, không huỷ khi đã PICKED; seller chết → kho mặc định | ✅ |

## services/user-profile

| # | Test | Kết quả |
|---|---|---|
| 1 | user.registered → tạo hồ sơ (idempotent); GET/PUT /me/profile | ✅ |
| 2 | sổ địa chỉ: địa chỉ đầu tự mặc định, đổi mặc định bỏ cái cũ, tối đa 10, xoá mặc định thì chuyển | ✅ |
| 3 | user thứ 2 không thấy / sửa / xoá được địa chỉ của người khác; /internal/addresses | ✅ |
| 4 | wishlist thêm/kiểm tra/xoá, phân trang | ✅ |
| 5 | recently viewed: mới nhất trước, không trùng, tối đa 50 | ✅ |
