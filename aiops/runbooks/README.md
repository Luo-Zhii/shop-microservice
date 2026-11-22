# Runbook (runbook-as-code)

Mỗi file một tình huống, front matter khai `services`, `alerts`, `tags` để AIOps khớp chính xác; nội dung chia mục
`## Triệu chứng / Chẩn đoán / Khắc phục / Xác minh`. AIOps lập chỉ mục TF-IDF theo **từng mục** (`aiops/runbooks.py`; thư mục này nằm trong `aiops/` để được đóng gói vào image AIOps),
công cụ MCP `search_runbooks` và bảng sự cố hiển thị mục phù hợp nhất. Sửa runbook = sửa file này qua PR (có review).
