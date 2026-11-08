# Hồ sơ khoá luận — DevSecOps + AIOps cho sàn TMĐT microservice hybrid

**Đề tài:** Xây dựng nền tảng DevSecOps tích hợp AIOps cho hệ thống thương mại điện tử kiến trúc microservice trên hạ tầng
hybrid (on-premises và AWS).

| Chương | Tài liệu | Nội dung |
|---|---|---|
| 1. Tổng quan & đặc tả bài toán | [01-dac-ta-bai-toan.md](01-dac-ta-bai-toan.md) | Bối cảnh, hạn chế v1, 6 mục tiêu, phạm vi, tác nhân, 63 yêu cầu chức năng, 11 yêu cầu phi chức năng, 5 câu hỏi nghiên cứu |
| 2. Cơ sở lý thuyết | [02-co-so-ly-thuyet.md](02-co-so-ly-thuyet.md) | Microservice/DDD, saga + outbox/inbox, chịu lỗi, Kubernetes + canary, GitOps, DevSecOps + SLSA, IaC hybrid, observability + SLO, AIOps (IsolationForest, Drain, MicroRCA), chaos, DORA; 18 tài liệu tham khảo |
| 3. Phân tích & thiết kế | [03-thiet-ke.md](03-thiet-ke.md) · [diagrams/](diagrams/) | Quyết định kiến trúc, phân rã service/dữ liệu, thuật toán AIOps (công thức), thiết kế bảo mật; **30 sơ đồ** |
| 4. Triển khai | [04-trien-khai.md](04-trien-khai.md) | 3 repo, thư viện nền, 15 service, web, pipeline CI/CD, GitOps & nền tảng, hạ tầng on-prem ↔ AWS, AIOps |
| 5. Kiểm thử | [05-kiem-thu.md](05-kiem-thu.md) · [test-report.md](test-report.md) | Chiến lược kiểm thử, ~110 test case + ma trận truy vết; **179/179 test tự động** |
| 6. Thực nghiệm & đánh giá | [06-thuc-nghiem.md](06-thuc-nghiem.md) | Kiểm thử đồng thời, AIOps (F1, PA-F1, MTTD, RCA Top-k, MTTR ước lượng), DevSecOps, việc còn chờ cụm thật |
| Kết luận | [07-ket-luan.md](07-ket-luan.md) | Kết quả so với mục tiêu, trả lời câu hỏi nghiên cứu, đóng góp, hạn chế, hướng phát triển |
| Phụ lục | [../architecture.md](../architecture.md) | Hợp đồng API / sự kiện / saga giữa các service |

## Sơ đồ

| Định dạng | Ở đâu | Dùng cho |
|---|---|---|
| **Mermaid** (30 sơ đồ, đủ mọi loại) | [diagrams/README.md](diagrams/README.md) | Xem trực tiếp trên GitHub, slide |
| **PNG/SVG Graphviz** (7 sơ đồ kiến trúc chính) | [diagrams/out/](diagrams/out/) — `diagrams/render-dot.sh` | Chèn vào báo cáo Word |
| **PlantUML** (30 sơ đồ UML chuẩn) | `diagrams/*.puml` — `diagrams/render.sh` | Xuất ảnh UML chất lượng in (cần cài `plantuml`) |

Ảnh có sẵn: [container](diagrams/out/container.png) · [saga](diagrams/out/saga.png) · [trạng thái đơn](diagrams/out/order-state.png)
· [Kafka](diagrams/out/kafka.png) · [hybrid](diagrams/out/deploy-hybrid.png) · [CI/CD](diagrams/out/cicd.png)
· [AIOps](diagrams/out/aiops-loop.png).
