# Chương 2 — Cơ sở lý thuyết

## 2.1. Kiến trúc microservice và thiết kế hướng miền (DDD)

Microservice là phong cách kiến trúc chia ứng dụng thành các dịch vụ nhỏ. Mỗi dịch vụ chạy trong tiến trình riêng, sở hữu
dữ liệu riêng và triển khai độc lập [1]. Ranh giới dịch vụ được xác định theo **bounded context** của DDD [2]: mỗi ngữ cảnh
có mô hình và ngôn ngữ riêng (ví dụ "Order" ở order-service khác "OrderItem" ở review-service).

| Đặc tính | Monolith | Microservice |
|---|---|---|
| Triển khai | Một khối | Từng dịch vụ độc lập |
| Mở rộng | Theo cả khối | Theo dịch vụ nóng (search, inventory) |
| Lỗi | Lan toàn hệ thống | Cô lập (bulkhead, circuit breaker) |
| Dữ liệu | Một CSDL, ACID toàn cục | Database-per-service, nhất quán cuối cùng |
| Chi phí vận hành | Thấp | Cao → **cần DevOps/Platform Engineering** |

Chính chi phí vận hành cao ở cột cuối là lý do đề tài ghép microservice với DevSecOps và AIOps.

## 2.2. Nhất quán dữ liệu phân tán

**Định lý CAP** [3]: khi mạng bị phân vùng, hệ phân tán chỉ giữ được một trong hai tính chất nhất quán hoặc sẵn sàng.
Sàn TMĐT ưu tiên sẵn sàng và chấp nhận **nhất quán cuối cùng** (BASE), trừ các điểm cần chính xác tuyệt đối: tồn kho,
tiền, suất flash sale.

**Saga** [4] là chuỗi giao dịch cục bộ $T_1, T_2, …, T_n$. Mỗi bước $T_i$ có một giao dịch bù $C_i$. Nếu bước $T_k$ thất bại,
hệ thống chạy $C_{k-1}, …, C_1$ để hoàn tác. Có hai cách tổ chức [5]:

- *Choreography*: các dịch vụ tự lắng nghe sự kiện của nhau. Ghép lỏng, nhưng khó nhìn ra toàn bộ luồng.
- *Orchestration*: một bộ điều phối (ở đây là order-service) giữ máy trạng thái và ra lệnh cho từng bước. Đề tài chọn
  cách này vì dễ quan sát và dễ bổ sung bù trừ.

Hai lỗi kinh điển khi kết hợp CSDL với message broker và cách khắc phục [5]:

| Vấn đề | Mô tả | Mẫu khắc phục |
|---|---|---|
| Dual-write | Ghi DB thành công nhưng gửi Kafka lỗi (hoặc ngược lại) | **Transactional Outbox**: ghi sự kiện vào bảng `outbox` trong cùng transaction, relay đọc rồi gửi đi |
| Giao trùng | Kafka đảm bảo at-least-once, một sự kiện có thể tới nhiều lần | **Inbox / Idempotent consumer**: bảng `processed_events` cùng transaction xử lý |
| Gửi lại request | Người dùng bấm hai lần, client retry | **Idempotency-Key** lưu kết quả lần đầu |
| Bán vượt khi đồng thời | Nhiều request giành cùng một đơn vị hàng | Khoá bi quan (`SELECT … FOR UPDATE`, khoá theo thứ tự để tránh deadlock) / thao tác nguyên tử (Redis Lua) |

## 2.3. Truyền thông giữa dịch vụ và khả năng chịu lỗi

- **Đồng bộ (HTTP/REST)**: chỉ dùng để đọc hoặc báo giá. Luôn có timeout, retry có backoff (chỉ với request idempotent)
  và **circuit breaker** [6]: sau N lỗi liên tiếp thì mở mạch, trả lỗi ngay thay vì đẩy thêm tải vào dịch vụ đang chết.
- **Bất đồng bộ (Kafka)**: log phân tán, chia partition, giữ thứ tự theo key, consumer group, đọc lại được. Mọi thay đổi
  trạng thái đều đi qua sự kiện. Sự kiện xử lý lỗi quá số lần cho phép được đẩy sang hàng đợi chết (DLQ).
- **API Gateway + BFF** [5]: một điểm vào duy nhất, lo xác thực và rate limit. BFF gom dữ liệu cho từng màn hình và vẫn trả
  phần còn lại khi một nguồn lỗi (graceful degradation).

## 2.4. Container, Kubernetes và triển khai lũy tiến

Kubernetes điều phối container theo mô hình **khai báo**: controller liên tục đưa trạng thái thực về trạng thái mong
muốn. Các đối tượng dùng trong đề tài: Deployment/Rollout, Service, HPA/KEDA (tự co giãn theo RPS hoặc lag Kafka),
PodDisruptionBudget, NetworkPolicy, probe (`/healthz` liveness, `/readyz` readiness).

**Canary release** [7]: chuyển dần 10% → 30% → 60% → 100% lưu lượng sang bản mới. Ở mỗi bước, tỉ lệ lỗi và độ trễ của bản
mới được so với ngưỡng (Argo Rollouts AnalysisTemplate); không đạt thì tự quay về bản cũ.

## 2.5. GitOps

Theo OpenGitOps [8], GitOps có 4 nguyên tắc:

1. **Khai báo**: trạng thái mong muốn được mô tả bằng khai báo.
2. **Có phiên bản, bất biến**: trạng thái đó lưu trong Git, có lịch sử đầy đủ.
3. **Kéo tự động**: agent trong cụm tự kéo trạng thái từ Git (pull), CI không đẩy thẳng vào cụm.
4. **Đồng bộ liên tục**: agent liên tục tự sửa sai lệch (drift).

Argo CD hiện thực các nguyên tắc này. **ApplicationSet** sinh tự động một Application cho mỗi cặp (cụm × dịch vụ), nhờ đó
một repo cấu hình phục vụ được cả cụm on-prem lẫn EKS (mô hình hub-spoke). Rollback chỉ là `git revert`.

## 2.6. DevSecOps và an ninh chuỗi cung ứng phần mềm

DevSecOps đưa bảo mật vào sớm trong vòng đời (*shift-left*), tự động hoá thành **cổng chặn** trong pipeline:

| Kỹ thuật | Phát hiện | Công cụ |
|---|---|---|
| Secret scanning | Khoá, token lộ trong mã | Gitleaks |
| SAST | Lỗi bảo mật trong mã nguồn | Semgrep, SonarQube |
| SCA | Thư viện có CVE | Trivy (fs) |
| IaC scan | Cấu hình hạ tầng sai | Trivy config / Checkov |
| Image scan | Lỗ hổng trong image | Trivy (image) |
| DAST | Lỗi khi chạy thật (OWASP Top 10) | OWASP ZAP |
| Policy-as-code | Workload vi phạm chính sách | Kyverno |

**An ninh chuỗi cung ứng** theo SLSA [9] gồm ba phần:

- **SBOM** (SPDX/CycloneDX) liệt kê mọi thành phần trong image.
- **Ký keyless bằng Sigstore** [10]: Cosign lấy chứng chỉ ngắn hạn từ Fulcio qua danh tính OIDC của GitHub Actions và ghi
  vào nhật ký minh bạch Rekor.
- **Kiểm tra ở cụm**: lúc admission, cụm chỉ cho chạy image có chữ ký với đúng issuer và subject (đúng repo).

**Danh tính liên kết (OIDC)** giữa GitHub và AWS giúp không còn access key dài hạn trong CI.

## 2.7. Hạ tầng dưới dạng mã và hybrid cloud

IaC mô tả hạ tầng bằng mã có phiên bản. Terraform dùng mô hình khai báo, có *state* (lưu trên S3 kèm khoá) và *plan* trước
khi *apply*. Ansible lo cấu hình hệ điều hành theo cách idempotent.

**Hybrid cloud** kết hợp on-prem (chi phí ổn định, chủ quyền dữ liệu) với cloud công cộng (co giãn, dịch vụ được quản lý).
Thách thức của mô hình này là giữ **khả chuyển**: cùng một bộ manifest phải chạy được trên RKE2 lẫn EKS, chỉ khác lớp
values theo môi trường (kho secret Vault hay AWS Secrets Manager, Postgres CloudNativePG hay RDS).

## 2.8. Khả năng quan sát (Observability)

Ba loại tín hiệu [11]:

- **Metrics**: chuỗi thời gian, rẻ, dùng để cảnh báo.
- **Logs**: sự kiện rời rạc, cho chi tiết.
- **Traces**: đường đi của một request qua nhiều dịch vụ (span, ngữ cảnh W3C `traceparent`).

**OpenTelemetry** chuẩn hoá cả ba (SDK + OTLP + Collector). Bộ **LGTM** lưu trữ chúng: Loki (log), Grafana (hiển thị),
Tempo (trace), Mimir/Prometheus (metric).

Đề tài dùng hai phương pháp chọn metric:

- **RED** (Rate, Errors, Duration) cho từng dịch vụ.
- **USE** (Utilization, Saturation, Errors) cho tài nguyên.

**SLI/SLO/Error budget** [12]:

- **SLI** là chỉ số đo được, ví dụ tỉ lệ request thành công.
- **SLO** là mục tiêu cho SLI, ví dụ 99.5% trong 30 ngày.
- **Error budget** $= 1 - SLO$ là lượng lỗi được phép.

Cảnh báo dùng **burn rate** đa cửa sổ, tức tốc độ tiêu hao error budget: ví dụ cảnh báo khi tốc độ đó vượt 14.4 lần trong
cả cửa sổ 1 giờ lẫn 5 phút. Cách này vừa nhạy vừa ít báo động giả.

## 2.9. AIOps

AIOps [13] áp dụng học máy vào dữ liệu vận hành theo ba bước: **phát hiện → chẩn đoán → phản ứng**.

### Phát hiện bất thường

- **Ngưỡng tĩnh**: đơn giản, nhưng bỏ sót các bất thường "lạ" (CPU tăng mà lỗi chưa tăng) hoặc phải đặt ngưỡng thấp và
  chịu nhiều báo động giả.
- **Robust z-score**: $z = (x - \tilde{x}) / (1.4826 \cdot \mathrm{MAD})$, với $\tilde{x}$ là trung vị. Dùng trung vị và
  MAD nên không bị chính các điểm bất thường kéo lệch như cách dùng trung bình và độ lệch chuẩn.
- **Isolation Forest** [14]: điểm bất thường là điểm dễ bị tách riêng bằng các phép chia ngẫu nhiên. Độ dài đường đi trung
  bình $E[h(x)]$ càng ngắn thì càng bất thường; điểm số
  $s(x,n) = 2^{-E[h(x)]/c(n)}$, trong đó $c(n)$ là độ dài đường đi trung bình của một tìm kiếm thất bại trên cây nhị phân
  $n$ điểm.
- **Log**: Drain [15] gom log thành *template* bằng cây phân tích có độ sâu cố định. Template mới, hoặc tần suất của một
  template lỗi tăng đột biến, là dấu hiệu bất thường.

### Phân tích nguyên nhân gốc (RCA)

Lỗi lan ngược theo chiều gọi: payment chậm làm order chậm, order chậm làm gateway chậm. **MicroRCA** [16] dựng đồ thị gọi
có trọng số theo bất thường rồi chạy **personalized PageRank**:

$$PR = (1-d)\,\mathbf{v} + d\,M^\top PR$$

Trong đó $M$ là ma trận chuyển trên đồ thị đảo chiều, có trọng số theo tương quan và điểm bất thường; vector cá nhân hoá
$\mathbf{v} \propto$ điểm bất thường của từng dịch vụ. Đỉnh có $PR$ cao nhất là ứng viên nguyên nhân gốc.

### Phản ứng

Tác tử dùng **LLM** để tóm tắt bối cảnh và chọn hành động từ runbook (rollback, scale, restart). Hành động chỉ chạy sau
khi **con người duyệt** (human-in-the-loop), trong allowlist và có ghi audit. Cách làm này tránh rủi ro mô hình "ảo giác"
rồi tự thao tác trên production.

### Chỉ số đánh giá

- Precision, Recall, F1.
- **Point-adjusted F1 (PA-F1)**: chỉ cần phát hiện một điểm trong đoạn sự cố là tính cả đoạn được phát hiện. Đây là cách
  đánh giá phổ biến cho chuỗi thời gian.
- MTTD (thời gian phát hiện), MTTR (thời gian khắc phục).
- RCA Top-k: tỉ lệ thí nghiệm có nguyên nhân thật nằm trong k vị trí đầu.

## 2.10. Kỹ thuật hỗn loạn (Chaos Engineering) và chỉ số DORA

**Chaos Engineering** [17] chủ động tiêm lỗi có kiểm soát (kill pod, trễ mạng, CPU hog) để kiểm chứng giả thuyết về độ
bền của hệ thống. Trong đề tài, mỗi thí nghiệm mang **nhãn nguyên nhân gốc** nên còn dùng làm dữ liệu đánh giá AIOps.

**DORA** [18] gồm 4 chỉ số hiệu quả giao phần mềm:

- Deployment frequency: tần suất triển khai.
- Lead time for changes: thời gian từ commit tới production.
- Change failure rate: tỉ lệ triển khai gây lỗi.
- Time to restore service: thời gian khôi phục (MTTR).

## Tài liệu tham khảo

1. J. Lewis, M. Fowler, "Microservices", martinfowler.com, 2014.
2. E. Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*, Addison-Wesley, 2003.
3. E. Brewer, "Towards robust distributed systems", PODC keynote, 2000; S. Gilbert, N. Lynch, "Brewer's conjecture…", *SIGACT News*, 2002.
4. H. Garcia-Molina, K. Salem, "Sagas", *ACM SIGMOD*, 1987.
5. C. Richardson, *Microservices Patterns*, Manning, 2018.
6. M. Nygard, *Release It!*, 2nd ed., Pragmatic Bookshelf, 2018.
7. J. Humble, D. Farley, *Continuous Delivery*, Addison-Wesley, 2010.
8. OpenGitOps, "GitOps Principles v1.0.0", CNCF, 2021.
9. SLSA, "Supply-chain Levels for Software Artifacts", slsa.dev, OpenSSF.
10. Z. Newman, J. S. Meyers, S. Torres-Arias, "Sigstore: Software Signing for Everybody", *ACM CCS*, 2022.
11. C. Majors, L. Fong-Jones, G. Miranda, *Observability Engineering*, O'Reilly, 2022.
12. B. Beyer et al., *The Site Reliability Workbook*, O'Reilly, 2018 (chương "Alerting on SLOs").
13. Gartner, "Market Guide for AIOps Platforms", 2017; Q. Cheng et al., "AI for IT Operations (AIOps) on Cloud Platforms: Reviews, Opportunities and Challenges", arXiv:2304.04661, 2023.
14. F. T. Liu, K. M. Ting, Z.-H. Zhou, "Isolation Forest", *IEEE ICDM*, 2008.
15. P. He, J. Zhu, Z. Zheng, M. R. Lyu, "Drain: An Online Log Parsing Approach with Fixed Depth Tree", *IEEE ICWS*, 2017.
16. L. Wu, J. Tordsson, E. Elmroth, O. Kao, "MicroRCA: Root Cause Localization of Performance Issues in Microservices", *IEEE/IFIP NOMS*, 2020.
17. A. Basiri et al., "Chaos Engineering", *IEEE Software*, 2016.
18. N. Forsgren, J. Humble, G. Kim, *Accelerate*, IT Revolution, 2018.
