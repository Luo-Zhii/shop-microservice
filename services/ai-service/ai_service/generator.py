"""Sinh mô tả sản phẩm tiếng Việt: template theo danh mục + LLM nếu có."""

from __future__ import annotations

import logging

from .llm import LLMError, LLMProvider
from .text import normalize

log = logging.getLogger("ai_service.generator")

CATEGORY_HINTS = [
    (("ao", "quan", "vay", "dam", "thoi trang", "giay", "dep", "tui"),
     "Thiết kế dễ phối đồ, phù hợp đi làm, đi chơi hằng ngày.",
     "Giặt ở nhiệt độ thường, lộn trái khi giặt để giữ màu; không dùng chất tẩy mạnh."),
    (("dien thoai", "laptop", "tai nghe", "loa", "dong ho", "sac", "may tinh", "dien tu", "camera"),
     "Hiệu năng ổn định, đáp ứng tốt nhu cầu học tập, làm việc và giải trí.",
     "Sản phẩm chính hãng, bảo hành theo chính sách của nhà sản xuất; giữ hoá đơn để được hỗ trợ."),
    (("my pham", "kem", "son", "serum", "duong da", "sua rua mat", "nuoc hoa"),
     "Thành phần dịu nhẹ, phù hợp chăm sóc da hằng ngày.",
     "Thử trên vùng da nhỏ trước khi dùng; bảo quản nơi khô ráo, tránh ánh nắng trực tiếp."),
    (("noi", "chao", "bep", "gia dung", "ban", "ghe", "nha cua", "binh"),
     "Bền bỉ, tiện dụng, giúp không gian sống gọn gàng hơn.",
     "Vệ sinh bằng khăn mềm, tránh va đập mạnh để sản phẩm bền lâu."),
    (("thuc pham", "banh", "keo", "tra", "ca phe", "do an"),
     "Hương vị thơm ngon, đóng gói cẩn thận, an toàn vệ sinh thực phẩm.",
     "Bảo quản nơi khô ráo thoáng mát; dùng trước hạn sử dụng in trên bao bì."),
]
DEFAULT_HINT = ("Chất lượng ổn định, được người bán kiểm tra kỹ trước khi giao.",
                "Kiểm tra sản phẩm khi nhận hàng; liên hệ shop nếu cần hỗ trợ đổi trả.")


def _hint(text: str) -> tuple[str, str]:
    n = normalize(text)
    for keys, use, care in CATEGORY_HINTS:
        if any(f" {k} " in f" {n} " for k in keys):
            return use, care
    return DEFAULT_HINT


def template_description(title: str, attributes: dict[str, str], category: str | None = None,
                         brand: str | None = None, keywords: list[str] | None = None) -> tuple[str, list[str]]:
    use, care = _hint(" ".join([title, category or "", " ".join(attributes.values())]))
    highlights = [f"{k.strip().capitalize()}: {str(v).strip()}" for k, v in attributes.items() if str(v).strip()]
    if brand:
        highlights.insert(0, f"Thương hiệu: {brand}")
    intro = f"{title.strip()}"
    if category:
        intro += f" thuộc danh mục {category.strip()}"
    intro += f". {use}"
    lines = [intro, ""]
    if highlights:
        lines.append("Đặc điểm nổi bật:")
        lines += [f"• {h}" for h in highlights]
        lines.append("")
    if keywords:
        lines.append("Phù hợp cho: " + ", ".join(k.strip() for k in keywords if k.strip()) + ".")
    lines.append(f"Hướng dẫn sử dụng & bảo quản: {care}")
    lines.append("Cam kết: hàng đúng mô tả, đóng gói cẩn thận, hỗ trợ đổi trả trong 7 ngày theo chính sách ShopNow.")
    return "\n".join(lines).strip(), highlights


SYSTEM = (
    "Bạn là copywriter thương mại điện tử tiếng Việt. Viết mô tả sản phẩm 120–200 từ, giọng thân thiện, chuẩn SEO, "
    "có đoạn mở đầu, danh sách gạch đầu dòng đặc điểm, hướng dẫn bảo quản. CHỈ dùng thông tin được cung cấp, "
    "không bịa thông số, không hứa hẹn y tế/tuyệt đối. Không dùng markdown tiêu đề."
)


def generate(title: str, attributes: dict[str, str], category: str | None = None, brand: str | None = None,
             keywords: list[str] | None = None, llm: LLMProvider | None = None) -> dict:
    text, highlights = template_description(title, attributes, category, brand, keywords)
    if llm is not None and llm.available:
        facts = "\n".join(f"- {h}" for h in highlights) or "- (không có thuộc tính)"
        prompt = (f"Tên sản phẩm: {title}\nDanh mục: {category or '-'}\nThuộc tính:\n{facts}\n"
                  f"Từ khoá: {', '.join(keywords or []) or '-'}\nHãy viết mô tả.")
        try:
            return {"description": llm.chat([{"role": "user", "content": prompt}], system=SYSTEM, max_tokens=800),
                    "highlights": highlights, "provider": llm.name}
        except LLMError as e:
            log.warning("LLM sinh mô tả lỗi, dùng template: %s", e)
    return {"description": text, "highlights": highlights, "provider": "template"}
