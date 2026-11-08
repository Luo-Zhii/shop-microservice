# Hồ sơ khoá luận — DevSecOps + AIOps cho sàn TMĐT microservice hybrid

| Chương | Tài liệu | Nội dung |
|---|---|---|
| 1 | [01-dac-ta-bai-toan.md](01-dac-ta-bai-toan.md) | Bối cảnh, hạn chế v1, mục tiêu, phạm vi, tác nhân, 63 yêu cầu chức năng, 11 yêu cầu phi chức năng, câu hỏi nghiên cứu |
| 2 | [02-thiet-ke.md](02-thiet-ke.md) + [diagrams/](diagrams/) | 30 sơ đồ (C4, use case, lớp, ERD, tuần tự, hoạt động, trạng thái, triển khai, mạng, Kafka, quan sát, Gantt, mindmap), quyết định kiến trúc, thuật toán AIOps, thiết kế bảo mật |
| 3 | [03-test-plan.md](03-test-plan.md) | Chiến lược kiểm thử, ~110 test case, ma trận truy vết |
| 3 | [test-report.md](test-report.md) | Kết quả kiểm thử tự động sinh từ lần chạy thật |
| 4 | [04-thuc-nghiem.md](04-thuc-nghiem.md) | Thực nghiệm: e2e, đồng thời, tải k6, AIOps (F1, MTTD, Top-k), bảo mật, DORA |
| — | [../architecture.md](../architecture.md) | Hợp đồng API / sự kiện / saga giữa các service |

Gợi ý dàn ý báo cáo: Mở đầu → Ch.1 Tổng quan & đặc tả → Ch.2 Cơ sở lý thuyết (microservice, saga, GitOps, DevSecOps,
observability, AIOps) → Ch.3 Phân tích thiết kế (02) → Ch.4 Triển khai (repo, IaC, pipeline) → Ch.5 Kiểm thử & đánh giá
(03, test-report, 04) → Kết luận & hướng phát triển.
