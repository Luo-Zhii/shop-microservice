# Chương 3 — Kế hoạch & đặc tả kiểm thử

Kết quả chạy thật được sinh tự động vào [test-report.md](test-report.md) (`node tools/test-report/run.mjs`).

## 3.1. Chiến lược (kim tự tháp kiểm thử)

| Mức | Công cụ | Phạm vi | Chạy ở đâu |
|---|---|---|---|
| Unit | `node:test` + tsx, `go test`, `pytest` | Hàm thuần: tính tiền, TOTP, chữ ký VNPay, phân miền ship, slug, thuật toán AIOps | Mọi commit |
| Integration | `app.inject` + Postgres/Redis/Mongo thật (DB `<svc>_test`) + JWKS giả | Route + DB + phân quyền + handler sự kiện (Kafka tắt, gọi thẳng handler) | Mọi commit (service container trong CI) |
| Concurrency | goroutine / Promise.all 50–200 request | Không bán vượt kho / quota flash sale / usageLimit voucher | Mọi commit |
| Contract | Kiểu dùng chung `@shopnow/contracts`, typecheck toàn repo | Hình dạng sự kiện và snapshot | Mọi commit |
| End-to-end | `tests/e2e/run.ts` qua gateway, Kafka thật | Luồng sàn từ mở shop tới đánh giá + bù trừ | Local / môi trường dev |
| UI | `check-overflow.js` ở 320/375/768/1280 | Không tràn ngang, mobile-first | Trước khi merge UI |
| Hiệu năng | k6 (`tests/load/k6-shop.js`) | p95, tỉ lệ lỗi theo kịch bản | Thủ công / trước release |
| Bảo mật | Gitleaks, Semgrep, Trivy, ZAP, Kyverno test | SAST, SCA, secret, IaC, DAST, policy | CI + hằng đêm |
| Hạ tầng | `terraform validate`, tflint, ansible-lint, helm lint/template, kubeconform | IaC và manifest | CI repo IaC/GitOps |
| Chaos / AIOps | Chaos Mesh + `aiops.eval` | Phát hiện, RCA, MTTD/MTTR | Môi trường dev / offline |

**Tiêu chí vào:** service build được, hạ tầng test sẵn sàng. **Tiêu chí ra:** 100% test tự động qua; không có lỗ hổng
CRITICAL; e2e qua hết; không tràn ngang ở 4 cỡ màn hình; có bảng số liệu AIOps.

## 3.2. Môi trường

| Môi trường | Thành phần |
|---|---|
| Local | `deploy/compose/infra.yml` (PG 16, Redis 7, Redpanda 24.2, Mongo 7, MinIO, Mailpit), service chạy bằng node, inventory bằng image Go |
| CI | GitHub Actions ubuntu-latest + service container PG/Redis/Mongo |
| Dev/Staging | Cụm kind hoặc RKE2, Argo CD, LGTM, Chaos Mesh |

## 3.3. Đặc tả test case

Ký hiệu: **A** = tự động, **M** = thủ công. Cột "Tự động hoá" chỉ tới file test.

### Xác thực & tài khoản (identity, user-profile)
| Mã | Yêu cầu | Tiền điều kiện | Bước / dữ liệu | Kết quả mong đợi | Loại |
|---|---|---|---|---|---|
| TC-ID-01 | FR-B01 | — | Đăng ký email mới, mật khẩu hợp lệ | 201, user `emailVerified=false`, outbox có `user.registered` + `user.otp_requested` | A |
| TC-ID-02 | FR-B01 | Đã đăng ký | Đăng ký lại cùng email | 409 CONFLICT | A |
| TC-ID-03 | FR-B01 | Có OTP | Nhập đúng OTP | 200, `emailVerified=true` | A |
| TC-ID-04 | FR-B01 | Có OTP | Nhập sai 5 lần rồi nhập đúng | Lần 6 bị từ chối (429) | A |
| TC-ID-05 | FR-B01 | OTP quá 10' | Nhập OTP | 400 hết hạn | A |
| TC-ID-06 | FR-B02 | Chưa xác thực email | Đăng nhập | 403 EMAIL_NOT_VERIFIED | A |
| TC-ID-07 | FR-B02 | Đã xác thực | Sai mật khẩu 5 lần, lần 6 đúng | Bị khoá 15' (429) | A |
| TC-ID-08 | FR-B02 | Bật 2FA | Đăng nhập thiếu / sai / đúng TOTP | 401 / 401 / 200 | A |
| TC-ID-09 | FR-B02 | — | TOTP theo vector RFC 6238 | Khớp mã chuẩn | A |
| TC-ID-10 | FR-B03 | Đã đăng nhập | Refresh → nhận token mới; refresh lại token cũ | Lần 2: 401 TOKEN_REUSED, cả family bị thu hồi | A |
| TC-ID-11 | FR-B03 | — | Verify JWT qua JWKS (`kid`, iss, aud, exp) | Token hợp lệ được chấp nhận, token giả mạo bị 401 | A |
| TC-ID-12 | FR-B04 | — | Quên mật khẩu → OTP → đặt lại → đăng nhập mật khẩu mới | 200; mật khẩu cũ không còn dùng được | A |
| TC-ID-13 | FR-S01 | Có sự kiện `shop.approved` | Gọi handler | User có role seller + shopId; outbox `user.role_granted`; xử lý trùng không đổi gì | A |
| TC-ID-14 | FR-A05 | Admin | Khoá user → user đăng nhập | 403 / 401 | A |
| TC-UP-01 | FR-B05 | — | Thêm 11 địa chỉ | Địa chỉ thứ 11: 400 | A |
| TC-UP-02 | FR-B05 | 2 địa chỉ | Đặt B mặc định | Chỉ B mặc định | A |
| TC-UP-03 | NFR-05 | User 1, user 2 | User 2 đọc / sửa địa chỉ user 1 | 404 | A |
| TC-UP-04 | FR-B18 | — | Xem 60 sản phẩm, có trùng | Recently viewed ≤ 50, không trùng, mới nhất đầu | A |

### Shop & sản phẩm (seller, catalog, search)
| Mã | Yêu cầu | Tiền điều kiện | Bước / dữ liệu | Kết quả mong đợi | Loại |
|---|---|---|---|---|---|
| TC-SE-01 | FR-S01 | Buyer | Nộp hồ sơ shop | 201 PENDING; trả `idNumber` dạng `****1234`; lưu DB đã mã hoá | A |
| TC-SE-02 | FR-S01 | Đã có shop | Nộp shop thứ 2 | 409 | A |
| TC-SE-03 | FR-A01 | Buyer thường | Gọi approve | 403 | A |
| TC-SE-04 | FR-A01 | Admin | Approve / reject (lý do) / suspend | Trạng thái đổi, outbox `shop.*` | A |
| TC-CA-01 | FR-S02 | Seller có shopId | Tạo sản phẩm 2 biến thể | 201, slug bỏ dấu, min/max price đúng, outbox `product.upserted` | A |
| TC-CA-02 | FR-S02 | — | SKU trùng / giá < 1000 / thiếu biến thể | 400 VALIDATION_ERROR | A |
| TC-CA-03 | FR-A02 | Sản phẩm PENDING | Khách xem trước khi duyệt; admin duyệt; khách xem | 404 → 200 | A |
| TC-CA-04 | FR-B06 | Cây danh mục | Lọc theo danh mục cha | Gồm cả sản phẩm ở danh mục con | A |
| TC-CA-05 | NFR-05 | — | `/internal/skus` không có x-internal-token | 403 | A |
| TC-CA-06 | FR-S02 | Seller | Xin presigned URL loại `image/png` | URL PUT hết hạn 10' + publicUrl | A |
| TC-CA-07 | FR-A01 | Sự kiện `shop.suspended` | Gọi handler | Sản phẩm của shop bị ẩn khỏi danh sách công khai | A |
| TC-SR-01 | FR-B07 | Index "Áo thun cotton" | Tìm "ao thun" | Có kết quả (không dấu) | A |
| TC-SR-02 | FR-B07 | — | Sai chính tả nhẹ "ao thung" | Có kết quả (trigram) | A |
| TC-SR-03 | FR-B07 | — | Lọc giá, rating, sort price_asc | Đúng thứ tự, facet đếm đúng | A |
| TC-SR-04 | FR-A02 | Sản phẩm bị ẩn | Sự kiện product.upserted HIDDEN | Biến mất khỏi kết quả | A |
| TC-SR-05 | FR-B07 | — | Dựng query OpenSearch (asciifolding, aggregations) | JSON query đúng cấu trúc | A |

### Giỏ, khuyến mãi, kho
| Mã | Yêu cầu | Tiền điều kiện | Bước / dữ liệu | Kết quả mong đợi | Loại |
|---|---|---|---|---|---|
| TC-CT-01 | FR-B09 | Khách | Thêm món với x-cart-id | Giỏ khách có món, TTL 30 ngày | A |
| TC-CT-02 | FR-B09 | Giỏ khách + giỏ user | Merge | Cộng dồn số lượng, xoá giỏ khách | A |
| TC-CT-03 | FR-B09 | — | qty = 0 / 100; dòng thứ 101 | 400 | A |
| TC-CT-04 | FR-B09 | Inventory chết | GET /cart | 200, `available=null`, không lỗi cả giỏ | A |
| TC-CT-05 | FR-B11 | Sự kiện order.created | Gọi handler 2 lần | Món đã đặt bị xoá, lần 2 không tác dụng | A |
| TC-PM-01 | FR-B10 | Voucher shop 10% trần 20k, đơn 300k | Quote | Giảm 20.000 | A |
| TC-PM-02 | FR-B10 | Voucher sàn chia cho 2 shop | Quote | Tổng phần chia = giá trị voucher (số nguyên) | A |
| TC-PM-03 | FR-B10 | minOrder 500k, đơn 300k | Quote | 400 kèm lý do | A |
| TC-PM-04 | FR-B10 | perUserLimit 1 | Dùng lần 2 | 400 | A |
| TC-PM-05 | NFR-03 | Flash sale quota 10 | **200 request đồng thời** | Đúng 10 được giá sale, Redis + PG đều = 10 | A |
| TC-PM-06 | FR-B10 | commit=true cùng checkoutId 2 lần | Quote | Kết quả giống hệt, không khoá thêm | A |
| TC-PM-07 | FR-B14 | order.cancelled (BUYER_CANCELLED) | Handler | Nhả voucher shop + suất flash sale, giữ voucher sàn | A |
| TC-IN-01 | NFR-03 | Tồn 10 | 50 goroutine giữ 1 đơn vị | Đúng 10 thành công, không âm kho | A |
| TC-IN-02 | FR-B11 | 2 SKU, 1 thiếu | Reserve | Không giữ món nào (all-or-nothing), reserve_failed | A |
| TC-IN-03 | NFR-03 | — | Reserve trùng reservationId | Trả kết quả cũ, không giữ thêm | A |
| TC-IN-04 | FR-B12 | Đã giữ | Commit / release / quá hạn | on_hand, reserved đúng; sự kiện tương ứng | A |
| TC-IN-05 | FR-S05 | Seller shop A | Sửa tồn SKU của shop B | 403 | A |
| TC-IN-06 | FR-S05 | reserved = 3 | Đặt onHand = 2 | 409 | A |

### Đặt hàng, thanh toán, vận chuyển (saga)
| Mã | Yêu cầu | Tiền điều kiện | Bước / dữ liệu | Kết quả mong đợi | Loại |
|---|---|---|---|---|---|
| TC-OR-01 | FR-B11 | Giỏ 2 shop | Checkout | 2 đơn, tổng/phí ship/giảm giá từng đơn đúng; outbox `order.created`×2 + `inventory.reserve` | A |
| TC-OR-02 | FR-B12 | — | Checkout lặp cùng Idempotency-Key | Cùng checkoutId, header `idempotent-replayed` | A |
| TC-OR-03 | FR-B12 | — | Cùng key, body khác | 409 | A |
| TC-OR-04 | FR-B11 | COD | reserved | CONFIRMED + `inventory.commit` + `order.confirmed` | A |
| TC-OR-05 | FR-B12 | MOCK | reserved → payment.succeeded | AWAITING_PAYMENT → CONFIRMED | A |
| TC-OR-06 | FR-B11 | — | reserve_failed | CANCELLED (OUT_OF_STOCK) | A |
| TC-OR-07 | FR-B12 | AWAITING_PAYMENT | payment.failed | CANCELLED + `inventory.release` | A |
| TC-OR-08 | FR-B12 | AWAITING_PAYMENT quá 15' | Chạy sweeper (thời gian giả) | CANCELLED (PAYMENT_TIMEOUT) | A |
| TC-OR-09 | FR-B14 | Đã trả online, CONFIRMED | Huỷ | CANCELLED + `payment.refund` | A |
| TC-OR-10 | FR-B12 | Đơn đã huỷ | payment.succeeded đến muộn | Tự phát `payment.refund` (LATE_PAYMENT) | A |
| TC-OR-11 | NFR-03 | — | Cùng sự kiện giao 2 lần | Chỉ xử lý 1 lần (processed_events) | A |
| TC-OR-12 | FR-B13 | CONFIRMED | shipment.picked / delivered | SHIPPING → DELIVERED | A |
| TC-OR-13 | FR-B15 | DELIVERED quá 3 ngày | Sweeper | COMPLETED + `order.completed` | A |
| TC-OR-14 | FR-B16 | DELIVERED ≤ 7 ngày | Trả hàng → seller duyệt | RETURNED + `payment.refund` | A |
| TC-OR-15 | FR-S10 | Có đơn | Seller stats 30 ngày | Doanh thu theo ngày, top sản phẩm đúng | A |
| TC-OR-16 | NFR-05 | Buyer B | Xem đơn của buyer A | 404 | A |
| TC-PA-01 | FR-B12 | payment.request VNPAY | Tạo URL | Chữ ký HMAC-SHA512 đúng chuẩn VNPay 2.1.0 | A |
| TC-PA-02 | FR-B12 | — | IPN sai chữ ký / gọi lặp | RspCode 97 / 02, không đổi trạng thái 2 lần | A |
| TC-PA-03 | FR-B12 | MOCK | Trang /pay/mock → complete success | payment.succeeded, redirect returnUrl | A |
| TC-PA-04 | FR-B14 | Đã trả | refund 2 lần cùng order | Chỉ hoàn 1 lần | A |
| TC-PA-05 | FR-S09 | order.completed, subtotal 300k, giảm 30k, ship 20k | Ghi có ví | Nhận = total − ship − round(5% × 270k) | A |
| TC-PA-06 | FR-S09 | Số dư X | Rút X + 1 | 400 | A |
| TC-SH-01 | FR-B11 | HN → HCM 1.4 kg | Quote | 40.000 + 5.000 (vượt 1 kg) | A |
| TC-SH-02 | FR-B11 | "TP. Hồ Chí Minh", "HCM", "ho chi minh" | Map miền | Cùng tỉnh / miền Nam | A |
| TC-SH-03 | FR-B13 | order.confirmed | Handler | Vận đơn + mã tracking duy nhất, outbox `shipment.created` | A |
| TC-SH-04 | NFR-05 | — | Webhook sai chữ ký | 401 | A |

### Đánh giá, thông báo, AI
| Mã | Yêu cầu | Tiền điều kiện | Bước / dữ liệu | Kết quả mong đợi | Loại |
|---|---|---|---|---|---|
| TC-RV-01 | FR-B17 | Chưa mua | Đánh giá | 403 | A |
| TC-RV-02 | FR-B17 | Đã mua (order.completed) | Đánh giá 2 lần cùng đơn/sản phẩm | Lần 2: 409 | A |
| TC-RV-03 | FR-A08 | AI trả `allowed=false` | Đánh giá | HIDDEN | A |
| TC-RV-04 | FR-A08 | ai-service timeout | Đánh giá | PUBLISHED (fail-open) | A |
| TC-RV-05 | FR-B08 | 3 đánh giá 5,4,3 | Summary | avg 4.0, phân bố đúng; sự kiện `product.rating_changed` | A |
| TC-NT-01 | FR-B19 | user.otp_requested | Handler | Email chứa OTP gửi tới SMTP | A |
| TC-NT-02 | FR-B19 | order.cancelled | Handler | Thông báo buyer kèm lý do tiếng Việt; seller nhận "đơn bị huỷ" | A |
| TC-NT-03 | FR-B19 | Đang mở SSE | Có thông báo mới | Client nhận sự kiện SSE | A |
| TC-AI-01 | FR-B20 | FAQ đổi trả | Hỏi "đổi trả thế nào" | Trả lời có nguồn FAQ (LLM_PROVIDER=none) | A |
| TC-AI-02 | FR-B08 | Lịch sử đồng mua | Gợi ý theo sản phẩm | Món đồng mua xếp trên | A |
| TC-AI-03 | FR-A08 | Văn bản có từ cấm / link spam | Moderate | `allowed=false`, nhãn đúng | A |
| TC-AI-04 | — | httpx MockTransport | Adapter Ollama / Anthropic / Bedrock | Gửi đúng định dạng, đọc đúng phản hồi | A |

### Gateway & phi chức năng
| Mã | Yêu cầu | Bước | Kết quả mong đợi | Loại |
|---|---|---|---|---|
| TC-GW-01 | NFR-05 | `/api/catalog/internal/skus`, `%69nternal`, `..%2f` | 403 mọi biến thể | A |
| TC-GW-02 | NFR-05 | Token sai chữ ký | 401 | A |
| TC-GW-03 | NFR-05 | 31 request đăng nhập / phút | Request 31: 429 RATE_LIMITED | A |
| TC-GW-04 | NFR-01 | BFF khi review-service chết | 200 + `degraded:["reviewSummary"]` | A |
| TC-GW-05 | NFR-06 | Request có x-request-id | Upstream nhận cùng id | A |
| TC-NF-01 | NFR-02 | k6 50 req/s, 10' | p95 đọc < 300 ms, checkout p95 < 1.5 s, lỗi < 2% | M |
| TC-NF-02 | NFR-01 | Kill pod order giữa saga (Chaos Mesh) | Saga tiếp tục sau khi pod mới lên, không mất đơn | M |
| TC-NF-03 | NFR-06 | Một request checkout | Trace xuyên gateway → order → Kafka → inventory | M |
| TC-NF-04 | NFR-10 | 4 cỡ màn hình × 6 trang | Không tràn ngang | A |
| TC-NF-05 | NFR-05 | SIGTERM khi đang xử lý | Service tắt êm < 15 s, readiness 503 trước khi tắt | M |

### Nền tảng DevSecOps
| Mã | Yêu cầu | Bước | Kết quả mong đợi | Loại |
|---|---|---|---|---|
| TC-PL-01 | FR-P03 | Commit chứa AWS key giả | Gitleaks chặn pipeline | M |
| TC-PL-02 | FR-P03 | Thêm dependency có CVE CRITICAL | Trivy chặn | M |
| TC-PL-03 | FR-P04 | Deploy image không chữ ký | Kyverno từ chối ở admission | A (kyverno test) |
| TC-PL-04 | FR-P04 | Pod chạy root / tag latest / thiếu limits | Kyverno từ chối | A (kyverno test) |
| TC-PL-05 | FR-P02 | Đổi 1 file trong services/cart | Chỉ image cart được build | A (changed-services) |
| TC-PL-06 | FR-P06 | `helm template` 4 env × 17 service | Render không lỗi, kubeconform hợp lệ | A |
| TC-PL-07 | FR-P01 | `terraform validate` bootstrap / aws-dev / aws-prod / onprem | Hợp lệ | A |
| TC-PL-08 | FR-P07 | Bản lỗi tăng 5xx | Argo Rollouts abort, quay về bản cũ | M |
| TC-PL-09 | FR-P05 | Sửa tay replicas trên cụm | Argo CD self-heal về giá trị git | M |
| TC-PL-10 | FR-P13 | Pipeline lỗi | ci-assistant phân loại lỗi đúng (log mẫu) | A |

### AIOps
| Mã | Yêu cầu | Bước | Kết quả mong đợi | Loại |
|---|---|---|---|---|
| TC-AO-01 | FR-P10 | Chuỗi bình thường + đột biến latency | Detector đánh dấu đúng service, đúng cửa sổ | A |
| TC-AO-02 | FR-P10 | Log có template lỗi mới | Điểm log tăng | A |
| TC-AO-03 | FR-P11 | Lỗi tiêm ở payment lan lên order, gateway | RCA xếp payment Top-1 | A |
| TC-AO-04 | FR-P12 | Webhook alert + deploy gần đây | Đề xuất rollback; chưa duyệt thì không thực thi | A |
| TC-AO-05 | FR-P12 | Hành động ngoài allowlist | Từ chối, ghi audit | A |
| TC-AO-06 | FR-P12 | Token duyệt sai HMAC | 403 | A |
| TC-AO-07 | FR-P14 | Eval tổng hợp 30 kịch bản | Báo cáo P/R/F1, MTTD, Top-1/3 | A |

## 3.4. Ma trận truy vết (rút gọn)

| Yêu cầu | Test case |
|---|---|
| FR-B01..B04 | TC-ID-01..12 |
| FR-B05, B18 | TC-UP-01..04 |
| FR-B07 | TC-SR-01..05 |
| FR-B09, B10 | TC-CT-01..05, TC-PM-01..07 |
| FR-B11..B16 | TC-OR-01..16, TC-PA-01..04, TC-SH-01..04, TC-IN-01..04 |
| FR-B17, A08 | TC-RV-01..05, TC-AI-03 |
| FR-B19, B20 | TC-NT-01..03, TC-AI-01 |
| FR-S01..S10 | TC-SE-01..04, TC-CA-01..07, TC-IN-05..06, TC-OR-15, TC-PA-05..06 |
| FR-P01..P14 | TC-PL-01..10, TC-AO-01..07 |
| NFR-01..10 | TC-GW-01..05, TC-NF-01..05, TC-PM-05, TC-IN-01 |
