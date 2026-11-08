# Chương 1 — Đặc tả bài toán

**Đề tài:** Xây dựng nền tảng DevSecOps tích hợp AIOps cho hệ thống thương mại điện tử kiến trúc microservice trên
hạ tầng hybrid (on-premises và AWS).
*An AI-Driven DevSecOps & AIOps Platform for Cloud-Native Microservices on Hybrid Infrastructure.*

## 1.1. Bối cảnh và động lực

Các sàn thương mại điện tử (Shopee, Tiki, Lazada…) có ba đặc điểm khiến vận hành trở nên khó:

1. **Nghiệp vụ phân tán**: một lần đặt hàng chạm tới 6–8 miền nghiệp vụ (giỏ hàng, giá, khuyến mãi, kho, thanh toán,
   vận chuyển, thông báo). Nếu gộp vào một khối (monolith) thì một lỗi nhỏ ở khuyến mãi có thể làm sập cả checkout.
   Còn nếu tách thành microservice thì lại phải giải bài toán nhất quán dữ liệu phân tán.
2. **Thay đổi liên tục**: đội ngũ deploy nhiều lần mỗi ngày. Không có pipeline tự động kèm cổng bảo mật thì một lỗ hổng
   hay một bản build lỗi sẽ vào thẳng production.
3. **Sự cố khó chẩn đoán**: khi checkout chậm, nguyên nhân có thể ở payment, inventory, Kafka hay database. Kỹ sư SRE
   phải lần qua hàng chục dashboard, khiến thời gian phát hiện (MTTD) và khắc phục (MTTR) kéo dài.

Doanh nghiệp tại Việt Nam còn có thêm yêu cầu **hybrid**: dữ liệu nhạy cảm hoặc tải ổn định nằm on-premises (rẻ, chủ
động), còn tải đột biến hoặc mở rộng vùng thì đặt trên cloud (AWS). Bài toán đặt ra: **làm sao một quy trình, một bộ
cấu hình** triển khai được ở cả hai nơi.

Hệ thống xuất phát (v1 — repo `DevOps_Scripts`, `shop-gitops`, `shop-app`, `shop-microservice`) còn các hạn chế sau:

| Hạn chế v1 | Hệ quả |
|---|---|
| Ứng dụng chỉ có 3 nghiệp vụ (sản phẩm, giỏ hàng, người dùng), các service gọi nhau đồng bộ | Không phải một sàn thật; không có bài toán nhất quán phân tán |
| 16 EC2 nằm trong 1 AZ, tự cài GitLab, Harbor, ELK…, state Terraform lưu local | Đắt, không chịu được sự cố AZ, không làm việc nhóm được |
| Bước quét bảo mật trong CI có `allow_failure` hoặc `\|\| true` | Cổng bảo mật chỉ để trang trí |
| Image gắn tag `:latest`, 1 replica, thiếu probe/HPA/NetworkPolicy, mật khẩu để trong git | Không an toàn, không tự phục hồi |
| ELK và Prometheus tách rời, không có tracing | Không truy được nguyên nhân xuyên service |
| Không có AI/AIOps | Phát hiện và khắc phục sự cố hoàn toàn thủ công |

## 1.2. Mục tiêu

| # | Mục tiêu | Đo bằng |
|---|---|---|
| M1 | Xây dựng sàn TMĐT nhiều người bán theo kiến trúc microservice, nhất quán dữ liệu bằng saga + outbox | 15 service, kịch bản e2e đặt hàng → giao → đánh giá chạy thành công; test bù trừ khi lỗi |
| M2 | Pipeline DevSecOps có cổng chặn thật và chuỗi cung ứng phần mềm an toàn | Pipeline chặn khi test lỗi / lộ secret / lỗ hổng CRITICAL; image có SBOM và chữ ký Cosign, cụm từ chối image chưa ký |
| M3 | GitOps đa cụm hybrid: cùng một repo cấu hình triển khai lên cụm on-prem và EKS | Argo CD ApplicationSet sinh Application cho cả hai cụm; promote bằng PR; canary tự rollback |
| M4 | Quan sát hợp nhất metrics, logs, traces | Từ một alert nhảy được sang trace rồi sang log của cùng request |
| M5 | AIOps: phát hiện bất thường, tìm nguyên nhân gốc, tác tử LLM đề xuất và thực thi khắc phục (có người duyệt) | Precision/Recall/F1 so với ngưỡng tĩnh; RCA Top-1/Top-3; MTTD, MTTR trước và sau |
| M6 | Đo hiệu quả DevOps | 4 chỉ số DORA |

## 1.3. Phạm vi

**Trong phạm vi**
- Ứng dụng: người mua, người bán, quản trị sàn (chi tiết ở §1.5); thanh toán COD, cổng giả lập, VNPay sandbox;
  vận chuyển giả lập 3 hãng.
- Nền tảng: IaC (Terraform, Ansible), CI (GitHub Actions), CD (Argo CD + Argo Rollouts), bảo mật chuỗi cung ứng
  (Trivy, Semgrep, Gitleaks, Syft, Cosign, Kyverno), quan sát (OpenTelemetry, Prometheus, Loki, Tempo, Grafana),
  SLO (Sloth), chaos (Chaos Mesh), AIOps (Python).
- Hai môi trường đích: on-prem (Proxmox + RKE2) và AWS (EKS); có lab kind trên laptop để demo.

**Ngoài phạm vi**
- Cổng thanh toán thật, hãng vận chuyển thật (chỉ có adapter và sandbox).
- App di động native (web responsive thay thế).
- Huấn luyện mô hình ngôn ngữ lớn (chỉ dùng LLM có sẵn qua API hoặc Ollama).
- Multi-region active-active.

## 1.4. Tác nhân (actors)

| Tác nhân | Mô tả |
|---|---|
| Khách vãng lai | Xem, tìm sản phẩm, thêm vào giỏ hàng khách |
| Người mua (Buyer) | Tài khoản đã xác thực email; đặt hàng, thanh toán, đánh giá |
| Người bán (Seller) | Người mua đã mở shop và được duyệt; quản lý sản phẩm, kho, đơn, voucher, ví |
| Quản trị sàn (Admin) | Duyệt shop/sản phẩm, quản lý danh mục, khuyến mãi sàn, xử lý khiếu nại, chi trả |
| Kỹ sư DevOps/SRE | Viết code, mở PR, duyệt release, duyệt hành động khắc phục |
| Hệ thống ngoài | Cổng thanh toán (VNPay), hãng vận chuyển, SMTP, nhà cung cấp LLM |
| Tác tử AIOps | Phát hiện, chẩn đoán, đề xuất và thực thi hành động đã được duyệt |
| CI/CD (GitHub Actions, Argo CD) | Build, quét, ký, triển khai tự động |

## 1.5. Yêu cầu chức năng

### Người mua (FR-B)
| Mã | Yêu cầu |
|---|---|
| FR-B01 | Đăng ký bằng email, xác thực bằng OTP 6 số (hết hạn 10 phút, tối đa 5 lần sai) |
| FR-B02 | Đăng nhập; khoá 15 phút sau 5 lần sai; 2FA TOTP tuỳ chọn; đăng nhập Google |
| FR-B03 | Phiên đăng nhập: access token 15 phút, refresh token xoay vòng, phát hiện dùng lại token cũ |
| FR-B04 | Quên mật khẩu, đặt lại bằng OTP |
| FR-B05 | Hồ sơ cá nhân, sổ địa chỉ (≤10, một địa chỉ mặc định) |
| FR-B06 | Duyệt danh mục nhiều cấp, trang chủ (banner, flash sale, gợi ý, sản phẩm mới) |
| FR-B07 | Tìm kiếm có dấu / không dấu, gợi ý khi gõ, lọc theo danh mục/giá/đánh giá/shop, sắp xếp, có facet |
| FR-B08 | Xem chi tiết sản phẩm: chọn biến thể, tồn kho, giá flash sale, đánh giá, gợi ý tương tự |
| FR-B09 | Giỏ hàng cho khách và người đăng nhập, gộp khi đăng nhập, nhóm theo shop, cảnh báo đổi giá / hết hàng |
| FR-B10 | Áp voucher sàn, voucher shop, freeship; mua flash sale có giới hạn suất |
| FR-B11 | Checkout nhiều shop trong một lần, tự tách đơn theo shop, tính phí ship theo vùng |
| FR-B12 | Thanh toán COD / cổng giả lập / VNPay; không bị trừ tiền hai lần (idempotency) |
| FR-B13 | Theo dõi đơn và hành trình vận chuyển |
| FR-B14 | Huỷ đơn trước khi giao; hoàn tiền tự động nếu đã thanh toán online |
| FR-B15 | Xác nhận đã nhận hàng; hệ thống tự hoàn tất sau 3 ngày |
| FR-B16 | Yêu cầu trả hàng trong 7 ngày sau khi giao |
| FR-B17 | Đánh giá sản phẩm (1–5 sao, nội dung, ảnh), chỉ khi đã mua; mỗi sản phẩm/đơn một lần |
| FR-B18 | Danh sách yêu thích, sản phẩm đã xem, theo dõi shop |
| FR-B19 | Thông báo trong app thời gian thực và email |
| FR-B20 | Chatbot CSKH trả lời theo chính sách sàn (RAG) |

### Người bán (FR-S)
| Mã | Yêu cầu |
|---|---|
| FR-S01 | Nộp hồ sơ mở shop (thông tin pháp lý, ngân hàng, địa chỉ lấy hàng); dữ liệu nhạy cảm được che |
| FR-S02 | Tạo/sửa sản phẩm nhiều biến thể, upload ảnh trực tiếp lên kho đối tượng (presigned URL) |
| FR-S03 | AI gợi ý mô tả sản phẩm |
| FR-S04 | Gửi duyệt, ẩn, xoá sản phẩm |
| FR-S05 | Quản lý tồn kho theo SKU (không đặt thấp hơn số đang giữ chỗ) |
| FR-S06 | Xem và xử lý đơn: giao cho vận chuyển, duyệt/từ chối trả hàng |
| FR-S07 | Tạo voucher shop |
| FR-S08 | Trả lời đánh giá |
| FR-S09 | Ví: số dư, lịch sử, yêu cầu rút tiền; sàn thu 5% phí trên doanh thu hàng |
| FR-S10 | Thống kê doanh thu theo ngày, số đơn theo trạng thái, top sản phẩm |

### Quản trị sàn (FR-A)
| Mã | Yêu cầu |
|---|---|
| FR-A01 | Duyệt / từ chối / khoá shop |
| FR-A02 | Duyệt / từ chối / ẩn sản phẩm |
| FR-A03 | Quản lý cây danh mục |
| FR-A04 | Voucher sàn, flash sale, banner |
| FR-A05 | Quản lý người dùng (khoá / mở) |
| FR-A06 | Xem mọi đơn hàng, xử lý trả hàng |
| FR-A07 | Xử lý yêu cầu rút tiền của shop |
| FR-A08 | Ẩn đánh giá vi phạm (AI tự đánh dấu trước) |
| FR-A09 | Dashboard GMV, số đơn, tỉ lệ huỷ |

### Nền tảng DevSecOps / AIOps (FR-P)
| Mã | Yêu cầu |
|---|---|
| FR-P01 | Mọi hạ tầng tạo bằng code (Terraform + Ansible), state có khoá, dựng lại được từ đầu |
| FR-P02 | CI chỉ build service thay đổi; chạy unit, integration, typecheck, lint |
| FR-P03 | Cổng bảo mật: secret scan, SAST, SCA, IaC scan, image scan; lỗi HIGH/CRITICAL thì dừng pipeline |
| FR-P04 | Sinh SBOM, ký image keyless, cụm chỉ chạy image đã ký từ đúng repo |
| FR-P05 | GitOps: trạng thái mong muốn nằm trong git; Argo CD đồng bộ, tự sửa drift |
| FR-P06 | Một bộ cấu hình cho 4 môi trường (dev, staging, prod-onprem, prod-aws); promote bằng PR |
| FR-P07 | Canary release; tự rollback khi tỉ lệ lỗi hoặc p95 vượt ngưỡng |
| FR-P08 | Secret không nằm trong git (Vault on-prem / AWS Secrets Manager qua External Secrets) |
| FR-P09 | Telemetry hợp nhất OTel; dashboard RED, saga, Kafka; SLO kèm cảnh báo burn-rate |
| FR-P10 | Phát hiện bất thường theo metric và log, chấm điểm theo service |
| FR-P11 | Xếp hạng nguyên nhân gốc trên đồ thị gọi service |
| FR-P12 | Tác tử sự cố: gom bối cảnh, LLM tóm tắt, đề xuất hành động theo runbook, người duyệt qua chat, thực thi có allowlist và audit |
| FR-P13 | AI phân tích log CI lỗi và bình luận vào PR |
| FR-P14 | Thí nghiệm chaos có nhãn nguyên nhân để đánh giá AIOps; báo cáo DORA |

## 1.6. Yêu cầu phi chức năng

| Mã | Thuộc tính | Chỉ tiêu |
|---|---|---|
| NFR-01 | Sẵn sàng | Gateway 99.5% / 30 ngày (SLO); chịu được mất 1 node / 1 AZ (prod) |
| NFR-02 | Hiệu năng | p95 API đọc < 300 ms, checkout p95 < 1.5 s ở 50 req/s; saga hoàn tất < 3 s (COD) |
| NFR-03 | Nhất quán | Không bán vượt tồn kho (kể cả 200 request đồng thời), không trừ tiền hai lần, sự kiện xử lý đúng một lần (outbox + inbox) |
| NFR-04 | Mở rộng | Service stateless, HPA/KEDA theo RPS hoặc lag Kafka; DB tách theo service |
| NFR-05 | Bảo mật | OWASP Top 10: băm argon2, JWT RS256 + JWKS, rate limit, validate đầu vào, zero-trust giữa service, NetworkPolicy deny-by-default, non-root + read-only rootfs, không secret trong git |
| NFR-06 | Quan sát | 100% service có /healthz /readyz /metrics, trace xuyên Kafka (traceparent trong sự kiện), log JSON có trace_id |
| NFR-07 | Khả chuyển | Cùng chart/manifest chạy trên RKE2 on-prem và EKS; chỉ khác file values theo môi trường |
| NFR-08 | Phục hồi | RPO ≤ 5 phút (WAL backup CNPG / RDS PITR), RTO ≤ 30 phút (dựng lại từ IaC + GitOps) |
| NFR-09 | Chi phí | AWS dev ≈ 0,42 USD/giờ khi bật (≈ 7 USD cho 16 giờ demo; ≈ 300 USD nếu chạy 24/7), có `scripts/destroy-aws.sh`; prod ước 1.400–1.600 USD/tháng |
| NFR-10 | Tiện dụng | Giao diện tiếng Việt, mobile-first (320 px trở lên), không tràn ngang |
| NFR-11 | Bảo trì | Thư viện nền dùng chung, hợp đồng sự kiện có version (`*.v1`), ADR cho quyết định lớn |

## 1.7. Ràng buộc và giả định

- Máy phát triển cá nhân có tài nguyên hạn chế (≈14 GB RAM): dev local chạy service bằng tiến trình node thay vì
  15 container, quan sát bật theo profile.
- AWS chỉ bật khi demo để tiết kiệm chi phí; on-prem mô phỏng bằng Proxmox hoặc kind.
- LLM có thể không có (offline/không key) → mọi chức năng AI đều có chế độ dự phòng theo luật (`LLM_PROVIDER=none`).

## 1.8. Câu hỏi nghiên cứu

1. **RQ1** — Saga orchestration kết hợp outbox/inbox có đảm bảo nhất quán nghiệp vụ dưới lỗi mạng, trùng sự kiện
   và tải đồng thời không? (thí nghiệm: test đồng thời, chaos kill pod giữa saga)
2. **RQ2** — Pipeline DevSecOps với cổng chặn thật và chữ ký image ảnh hưởng thế nào tới lead time và change failure rate?
3. **RQ3** — Phát hiện bất thường đa biến (IsolationForest + robust z-score) có tốt hơn ngưỡng tĩnh về F1 và MTTD không?
4. **RQ4** — RCA bằng personalized PageRank trên đồ thị gọi service đạt Top-1/Top-3 bao nhiêu với các lỗi tiêm có nhãn?
5. **RQ5** — Tác tử LLM có người duyệt giảm MTTR bao nhiêu so với xử lý thủ công theo runbook?

## 1.9. Tiêu chí hoàn thành

- Kịch bản e2e toàn sàn chạy qua hết (xem [03-test-plan.md](03-test-plan.md)).
- Toàn bộ test tự động qua; báo cáo test sinh tự động ([test-report.md](test-report.md)).
- Có bảng số liệu AIOps (F1, MTTD, Top-k) và DORA.
- Có đủ sơ đồ thiết kế ([02-thiet-ke.md](02-thiet-ke.md)).
