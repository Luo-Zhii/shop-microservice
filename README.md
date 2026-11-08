# ShopNow v2 — Sàn TMĐT microservice (DevSecOps + AIOps)

Mã nguồn ứng dụng cho khoá luận **"Xây dựng nền tảng DevSecOps tích hợp AIOps cho hệ thống thương mại điện tử
kiến trúc microservice trên hạ tầng hybrid (on-premises và AWS)"**.

| Repo | Vai trò |
|---|---|
| **shop-microservice** (repo này) | 15 service + web + AIOps, CI DevSecOps (GitHub Actions) |
| [shop-gitops](https://github.com/Luo-Zhii/shop-gitops) | Helm chart, Argo CD ApplicationSet đa cụm, platform addons, policy, SLO, chaos |
| [DevOps_Scripts](https://github.com/Luo-Zhii/DevOps_Scripts) | Terraform (AWS EKS + on-prem Proxmox), Ansible RKE2, bootstrap |

## Kiến trúc

```
              Next.js web (Người mua · Seller Center · Admin)
                               │  /api/*
                     ┌─────────▼──────────┐  JWT (JWKS) · rate limit (Redis) · BFF
                     │    api-gateway     │
                     └─────────┬──────────┘
   HTTP đồng bộ (đọc / báo giá: timeout + retry + circuit breaker)
 ┌────────┬────────┬───────┬───┴────┬─────────┬──────────┬────────┬────────┐
identity profile  seller catalog  search   cart     promotion  order   ai-service
 (PG)     (PG+R)   (PG)   (PG+S3) (OS/PG)  (Redis)  (PG+Lua)   (PG)    (Python)
                                                                 │ saga (orchestration)
 ════════════════════ Kafka: outbox → topic → inbox (đúng-một-lần), DLQ ═══════════════════
        inventory (Go)     payment (COD/MOCK/VNPay, ví seller)    shipping    review (Mongo)
                                         notification (Mongo · SMTP · SSE)

Mọi service: /healthz /readyz /metrics (RED) · OpenTelemetry traces · log JSON có trace_id
              ─────▶ OTel Collector ─▶ Prometheus/Mimir · Loki · Tempo ─▶ Grafana ─▶ Alertmanager
                                                                                     │
                                 aiops: phát hiện bất thường · RCA (PageRank) · LLM agent ◀┘
```

- **Saga đặt hàng** (orchestration, order là nhạc trưởng): giữ kho → thanh toán → xác nhận → vận chuyển → hoàn tất;
  lỗi ở bất kỳ bước nào → bù trừ (nhả kho, nhả voucher, hoàn tiền). Chi tiết: [docs/architecture.md](docs/architecture.md).
- **Mẫu thiết kế**: database-per-service, Transactional Outbox + Inbox, idempotency key, optimistic/pessimistic lock,
  Redis Lua chống bán vượt flash sale, BFF chịu lỗi từng phần, circuit breaker, graceful shutdown.
- **Đa ngôn ngữ**: Node.js/TypeScript (Fastify) · Go (inventory) · Python (ai-service, aiops).

## Tính năng sàn

Người mua: đăng ký/OTP email, 2FA, Google OAuth · tìm kiếm có/không dấu + bộ lọc + gợi ý · biến thể size/màu · giỏ hàng
khách + gộp khi đăng nhập · voucher sàn/shop/freeship · flash sale · COD / cổng giả lập / VNPay sandbox · theo dõi
vận đơn · huỷ, trả hàng, hoàn tiền · đánh giá có ảnh (chỉ người đã mua) · wishlist · thông báo realtime · chatbot CSKH.
Người bán: mở shop + KYC · sản phẩm nhiều biến thể, ảnh upload thẳng S3/MinIO · AI viết mô tả · tồn kho · xử lý đơn ·
voucher shop · trả lời đánh giá · ví + rút tiền · thống kê doanh thu. Admin: duyệt shop/sản phẩm · danh mục · voucher
sàn · flash sale · banner · đơn hàng, trả hàng · người dùng · chi trả cho shop.

## Cấu trúc

```
packages/platform   thư viện nền: server, config, logger, OTel, metrics, auth JWKS, pg + migrate, Kafka bus, outbox/inbox, HTTP client
packages/contracts  tên topic + kiểu sự kiện/snapshot dùng chung
services/*          13 service Node, inventory (Go), ai-service (Python)
apps/web            Next.js 15 — 3 cổng
aiops/              phát hiện bất thường, RCA, incident agent, đánh giá (eval), CI assistant
deploy/compose      hạ tầng dev (Postgres, Redis, Redpanda, Mongo, MinIO, Mailpit, LGTM)
deploy/docker       Dockerfile dùng chung cho service Node
tests/e2e           kịch bản end-to-end toàn sàn qua gateway
tests/load          k6 tạo tải cho thí nghiệm AIOps
tools/dora          tính 4 chỉ số DORA từ lịch sử GitOps
legacy/v1           bản cũ (Node 4 service + Java) để đối chiếu
```

## Chạy local (máy dev, không cần K8s)

```bash
pnpm install
pnpm infra:up                                   # Postgres, Redis, Kafka, Mongo, MinIO, Mailpit
docker build -t shopnow/inventory:dev services/inventory
python3 -m venv .venv && .venv/bin/pip install -r services/ai-service/requirements.txt -r aiops/requirements.txt
REBUILD=1 scripts/dev.sh up && scripts/dev.sh status
pnpm --filter @shopnow/web dev                  # http://localhost:3000
pnpm e2e                                        # chạy toàn bộ kịch bản sàn
```

Tài khoản admin mặc định: `admin@shopnow.local` / `Admin@12345`. Email (OTP, đơn hàng): http://localhost:58025.
Quan sát local: `docker compose -f deploy/compose/infra.yml --profile observability up -d` rồi đặt
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` → Grafana http://localhost:3001.

## CI/CD DevSecOps (`.github/workflows`)

| Workflow | Nội dung |
|---|---|
| `ci.yml` | Chỉ build service thay đổi · typecheck/test Node, Go (`-race`), Python · build web · gitleaks · Semgrep · Trivy fs (chặn HIGH/CRITICAL) · SonarQube · build image → Trivy image (chặn CRITICAL) → SBOM SPDX (Syft) → **Cosign ký keyless + attest** → GHCR (+ Harbor on-prem, + ECR qua OIDC) → ghi tag vào `shop-gitops/environments/dev/images.yaml` |
| `promote.yml` | Promote dev → staging → prod-onprem/prod-aws bằng Pull Request (phê duyệt = release) |
| `dast.yml` | OWASP ZAP baseline hằng đêm trên môi trường dev |
| `ci-assistant.yml` | Pipeline lỗi → LLM đọc log, tóm tắt nguyên nhân + cách sửa, bình luận vào PR |
| `dora.yml` | Báo cáo DORA hằng tuần (deployment frequency, lead time, change failure rate, MTTR) |

Secrets/vars cần: `GITOPS_TOKEN` (fine-grained PAT ghi repo shop-gitops), tuỳ chọn `SONAR_TOKEN`, `HARBOR_*`,
`vars.AWS_ROLE_ARN` (role OIDC do Terraform tạo), `ANTHROPIC_API_KEY` + `vars.LLM_PROVIDER`.
