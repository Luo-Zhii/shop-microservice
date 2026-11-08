# Chương 4 — Triển khai

## 4.1. Tổ chức mã nguồn (3 repo, nhánh `dev/problem`)

| Repo | Nội dung | Kiểm chứng |
|---|---|---|
| `shop-microservice` | Monorepo pnpm: `packages/platform`, `packages/contracts`, 13 service Node/TS, `services/inventory` (Go), `services/ai-service` (Python), `aiops/` (Python), `apps/web` (Next.js 15), `.github/workflows`, `docs/` | 179 test tự động |
| `shop-gitops` | `charts/shopnow-service` (chart chung), `apps/shopnow` (values 17 dịch vụ), `environments/{dev,staging,prod-onprem,prod-aws}`, `argocd/` (AppProject, root app, 3 ApplicationSet), `platform/` (Kafka, CNPG, Kyverno, OTel, dashboard, SLO, chaos) | `make validate`: 68 tổ hợp helm template, 1027 manifest kubeconform, kyverno test 50/50 |
| `DevOps_Scripts` | `terraform/{bootstrap,modules,envs/aws-dev,aws-prod,onprem}`, `ansible/` (9 role), `local/` (kind), `scripts/` (bootstrap/destroy) | `terraform validate` 4 môi trường; ansible-lint profile production 0 lỗi |

Bản v1 của mỗi repo được giữ lại trong `legacy/v1/` (chuyển bằng `git mv`, nên lịch sử vẫn còn) để đối chiếu.

## 4.2. Thư viện nền `@shopnow/platform`

Mọi service Node dùng chung một khung, nhờ vậy 13 service có hành vi vận hành thống nhất:

| Mô-đun | Chức năng |
|---|---|
| `server.ts` | Fastify chuẩn hoá: log JSON, `x-request-id`, lỗi `{error:{code,message}}`, `/healthz` `/readyz` `/metrics`, tắt êm khi SIGTERM (readiness 503 → đóng server → hook → thoát, cưỡng bức sau 15 s) |
| `otel.ts` | OpenTelemetry SDK: instrument http, undici (fetch), pg, ioredis, kafkajs, mongodb; xuất OTLP |
| `metrics.ts` | prom-client: histogram RED `http_server_requests_seconds` (có bucket 1.5 s cho SLO), Kafka, outbox |
| `auth.ts` | Xác minh JWT RS256 qua JWKS, `requireRole`, `internalOnly` |
| `db.ts` | Pool pg, `withTx`, migration SQL có advisory lock (an toàn khi nhiều replica cùng khởi động) |
| `kafka.ts` | `EventBus` (producer idempotent, consumer: thử lại 3 lần → DLQ, nối trace từ `traceparent`), **outbox** (`enqueue` + relay `FOR UPDATE SKIP LOCKED`), **inbox** (`processOnce`) |
| `http.ts` | Client giữa các service: timeout, retry có backoff cho request idempotent, circuit breaker |
| `testing.ts` | JWKS giả + ký JWT, database test sạch theo từng service |

Đoạn lõi của outbox relay (cho phép chạy nhiều replica mà không gửi trùng):

```sql
BEGIN;
SELECT id, topic, payload FROM outbox ORDER BY created_at, id LIMIT 200 FOR UPDATE SKIP LOCKED;
-- gửi lên Kafka theo topic …
DELETE FROM outbox WHERE id = ANY($1::uuid[]);
COMMIT;
```

## 4.3. Các service nghiệp vụ

| Service | Điểm kỹ thuật chính |
|---|---|
| identity | argon2id, OTP băm + khoá sau 5 lần sai, refresh token theo *family* (dùng lại token cũ → thu hồi cả family), TOTP RFC 6238 tự cài, khoá ký RS256 lưu DB dùng chung giữa replica, JWKS |
| seller | KYC mã hoá AES-256-GCM, che số khi trả về; duyệt shop → `shop.approved` → identity cấp role seller + shopId |
| catalog | Biến thể/SKU, slug bỏ dấu tiếng Việt, presigned PUT lên S3/MinIO, duyệt sản phẩm, phát `product.upserted` (event-carried state transfer) |
| search | Engine trừu tượng: Postgres (bỏ dấu + `pg_trgm`, chịu gõ sai) hoặc OpenSearch (asciifolding, edge_ngram, aggregations); facet, gợi ý |
| inventory (Go) | Giữ chỗ all-or-nothing, khoá SKU theo thứ tự (không deadlock), commit/release/**restock**, sweeper hết hạn `SKIP LOCKED`, franz-go, distroless 24.6 MB |
| cart | Redis hash, giỏ khách + gộp khi đăng nhập, giới hạn kiểm bằng Lua, làm giàu từ catalog + inventory (chịu lỗi từng phần) |
| promotion | Voucher sàn/shop/freeship chia tỉ lệ số nguyên, flash sale giữ suất bằng **Redis Lua** nguyên tử, khoá voucher theo checkoutId (idempotent), sweeper nhả voucher bị bỏ quên |
| order | Nhạc trưởng saga: máy trạng thái chặt, `SELECT … FOR UPDATE`, Idempotency-Key, sweeper quá hạn thanh toán / tự hoàn tất, trả hàng, thống kê seller/admin |
| payment | COD / cổng giả lập / VNPay 2.1.0 (HMAC-SHA512, IPN), mỗi đơn chỉ hoàn tiền một lần, sổ cái ví seller (trừ 5% phí sàn), rút tiền |
| shipping | 63 tỉnh / 3 miền, 3 hãng giả lập, webhook HMAC-SHA256, giả lập tiến trạng thái |
| review | MongoDB, chỉ người đã mua mới được đánh giá, kiểm duyệt AI theo kiểu fail-open, outbox trên Mongo không cần transaction |
| notification | Sinh thông báo in-app + email từ sự kiện, SSE fan-out qua Redis pub/sub, chống gửi trùng |
| api-gateway | Proxy `/api/<svc>`, chặn `/internal` (kể cả biến thể mã hoá URL), rate limit Redis, BFF chịu lỗi từng phần, `/api/status` |
| ai-service | Gợi ý hybrid (đồng mua + TF-IDF), RAG chatbot trên FAQ, sinh mô tả, kiểm duyệt; adapter Ollama / Bedrock (SigV4) / Anthropic |

Đoạn lõi giữ kho không bán vượt (Go, trong một transaction, khoá theo thứ tự `sku_id`):

```sql
UPDATE stock SET reserved = reserved + $2
 WHERE sku_id = $1 AND on_hand - reserved >= $2;   -- 0 dòng bị sửa → hết hàng → ROLLBACK cả đơn
```

## 4.4. Giao diện web

Next.js 15 App Router, React 19, Tailwind v4, TanStack Query; khoảng 45 route trong 3 cổng:

- **Người mua**: trang chủ, tìm kiếm, chi tiết sản phẩm, giỏ, checkout + poll saga, đơn hàng + timeline, tài khoản,
  thông báo SSE, chatbot.
- **Seller Center**: mở shop, sản phẩm nhiều biến thể + upload ảnh, tồn kho, đơn, voucher, đánh giá, ví, thống kê.
- **Admin**: duyệt shop và sản phẩm, danh mục, voucher sàn, flash sale, banner, đơn, người dùng, chi trả, đánh giá.

Thiết kế mobile-first từ 320 px: bottom nav, bottom sheet bộ lọc, drawer cho seller/admin, ô nhập 16 px, vùng chạm 44 px.

## 4.5. Pipeline CI/CD (GitHub Actions)

`ci.yml` gồm các bước:

1. `changes`: chỉ chọn service thay đổi.
2. Chạy song song `node-test`, `go-test` (`-race`), `python-test` (gồm eval AIOps), `web-build`, `security` (Gitleaks,
   Semgrep, Trivy fs, Sonar).
3. `build-push` cho từng image: build → Trivy image (chặn CRITICAL) → push GHCR → SBOM Syft → `cosign sign` + `attest`;
   mirror sang Harbor (on-prem) và ECR (qua OIDC).
4. `update-gitops`: ghi tag + digest vào `shop-gitops/environments/dev/images.yaml`.

Các workflow khác:

- `promote.yml`: mở PR promote giữa các môi trường.
- `dast.yml`: ZAP baseline hằng đêm.
- `ci-assistant.yml`: khi CI lỗi, LLM phân tích log và bình luận vào PR.
- `dora.yml`: báo cáo DORA hằng tuần.

## 4.6. GitOps & nền tảng

- **Chart chung** `shopnow-service`:
  - Workload là Deployment hoặc Argo Rollout canary 10/30/60/100. AnalysisTemplate đo tỉ lệ 5xx và p95 của riêng bản
    canary, vượt ngưỡng thì abort.
  - Đi kèm HPA/KEDA, PDB, NetworkPolicy deny-by-default, ServiceMonitor, PrometheusRule, ExternalSecret.
  - securityContext: non-root, read-only rootfs, drop ALL. Chart từ chối tag `latest`.
- **ApplicationSet**:
  - `shopnow-apps` sinh Application cho mỗi cặp cụm × dịch vụ, chọn cụm theo nhãn `shopnow.io/env` / `shopnow.io/provider`.
  - `platform-addons`: 24 chart đã pin phiên bản.
  - `platform-config`: Kustomize theo môi trường, `prune=false` để không bao giờ tự xoá dữ liệu.
- **Platform**:
  - Kafka KRaft (Strimzi) với 10 topic + 10 DLQ.
  - CloudNativePG: 12 database, backup Barman lên MinIO/S3.
  - 6 ClusterPolicy Kyverno (verifyImages Cosign, cấm `latest`/root/privileged, bắt buộc limits và probe).
  - OTel Collector (spanmetrics + servicegraph), 4 dashboard Grafana, 3 SLO Sloth, Alertmanager → aiops + Telegram.
  - 6 thí nghiệm Chaos Mesh, mỗi cái gắn nhãn nguyên nhân gốc.

## 4.7. Hạ tầng hybrid

| Thành phần | On-prem | AWS |
|---|---|---|
| Máy chủ | Proxmox VM (Terraform bpg/proxmox, cloud-init) | VPC 3 AZ, EKS v20 (node on-demand + spot) |
| Kubernetes | RKE2 HA 3 control-plane + 3 worker, HAProxy + keepalived VIP | EKS managed |
| Lưu trữ | Longhorn | EBS gp3, S3 |
| CSDL | CloudNativePG trong cụm | RDS PostgreSQL 16 (Multi-AZ ở prod) |
| Cache | Redis operator | ElastiCache |
| Registry | Harbor | ECR (immutable, scan on push) |
| Secret | Vault → External Secrets | Secrets Manager + KMS → External Secrets (IRSA) |
| Cân bằng tải | MetalLB + ingress-nginx | AWS Load Balancer Controller (ALB) |
| CI runner | GitHub self-hosted runner trên VM tools | GitHub-hosted + OIDC role |

Thứ tự dựng:

1. `terraform/bootstrap`: tạo bucket state.
2. `envs/aws-*` hoặc `envs/onprem` + `ansible-playbook site.yml`.
3. Cài Argo CD hub và root app.
4. Đăng ký cụm kèm nhãn.
5. Argo CD tự đồng bộ addon, rồi tới ứng dụng.

Lab trên laptop dùng `local/scripts/local-up.sh` (kind 3 node).

## 4.8. AIOps

`aiops/` là một service FastAPI (cổng 8120):

- **Collectors**: Prometheus, Loki, service graph.
- **Detection**: robust z-score có hướng, IsolationForest, ngưỡng tĩnh, Drain3; điểm gộp ensemble.
- **RCA**: personalized PageRank kiểu MicroRCA.
- **Agent**:
  - Nhận webhook Alertmanager → gom bối cảnh (snapshot metric, log Loki, Deployment/Rollout vừa đổi revision, CrashLoop)
    → RCA → chọn hành động theo runbook → LLM tóm tắt.
  - Gửi Telegram/Slack kèm nút duyệt có token HMAC.
  - Executor có allowlist, mặc định `DRY_RUN`, ghi audit.
  - Lưu sự cố vào SQLite/Postgres kèm đủ mốc thời gian để tính MTTD/MTTR.
- **eval**: bộ mô phỏng tổng hợp + chaos runner.
- **ci_assistant**: phân tích log CI lỗi.

Metric xuất ra: `aiops_anomaly_score{service}`, `aiops_incidents_total`, `aiops_mttd_seconds`, `aiops_mttr_seconds`,
`aiops_actions_total`.
