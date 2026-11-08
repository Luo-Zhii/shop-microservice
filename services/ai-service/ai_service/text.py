"""Chuẩn hoá văn bản tiếng Việt: bỏ dấu, hạ chữ, tách từ đơn giản (không cần thư viện NLP nặng)."""

from __future__ import annotations

import re
import unicodedata

_WORD_RE = re.compile(r"[a-z0-9]+")


def strip_accents(text: str) -> str:
    """'Áo thun Đỏ' → 'Ao thun Do'. NFD rồi bỏ dấu kết hợp; đ/Đ không tách được bằng NFD nên thay tay."""
    text = text.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")


def normalize(text: str | None) -> str:
    if not text:
        return ""
    return " ".join(_WORD_RE.findall(strip_accents(text).lower()))


def tokens(text: str | None) -> list[str]:
    return normalize(text).split()
