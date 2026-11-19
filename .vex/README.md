# VEX (Vulnerability Exploitability eXchange)

SBOM cho biết image **chứa** gì; VEX cho biết một CVE **có khai thác được** trong cấu hình của ShopNow hay không.
Trivy chặn pipeline khi có CVE CRITICAL; nếu nhóm bảo mật đánh giá CVE đó không ảnh hưởng, thêm một statement vào
`shopnow.openvex.json` thay vì tắt quét:

```json
{
  "vulnerability": {"name": "CVE-YYYY-NNNNN"},
  "products": [{"@id": "pkg:oci/order?repository_url=ghcr.io/luo-zhii/shopnow/order"}],
  "status": "not_affected",
  "justification": "vulnerable_code_not_in_execute_path",
  "impact_statement": "Hàm lỗi chỉ dùng lúc build, không có trong runtime image (đã kiểm bằng SBOM)."
}
```

Quy tắc: mỗi statement phải có `justification` + `impact_statement`, qua review PR (CODEOWNERS nhóm bảo mật), và
tăng `version` + `timestamp`. CI ký tài liệu VEX cùng image (`cosign attest --type openvex`), nên người vận hành có thể
xác minh ai đã quyết định bỏ qua CVE nào, khi nào.
