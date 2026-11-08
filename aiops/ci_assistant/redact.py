"""Che bí mật trong log CI trước khi gửi LLM / đăng bình luận."""

from __future__ import annotations

import re

PATTERNS: list[tuple[str, re.Pattern]] = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b")),
    ("openai_like_key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("aws_secret", re.compile(r"(?i)(aws_secret_access_key\s*[=:]\s*)[\"']?[A-Za-z0-9/+=]{40}[\"']?")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("slack_webhook", re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+")),
    ("telegram_token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("bearer", re.compile(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._\-~+/=]{8,}")),
    ("url_credentials", re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+(@)")),
    ("kv_secret", re.compile(r"(?i)\b((?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)"
                             r"[\"']?\s*[=:]\s*)[\"']?[^\s\"',;]{6,}[\"']?")),
]


def redact(text: str) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}
    for name, pat in PATTERNS:
        def sub(m: re.Match, _name=name) -> str:
            counts[_name] = counts.get(_name, 0) + 1
            if m.lastindex and m.lastindex >= 1 and _name in ("aws_secret", "bearer", "kv_secret"):
                return m.group(1) + "***REDACTED***"
            if _name == "url_credentials":
                return m.group(1) + "***" + m.group(2)
            return f"***REDACTED:{_name}***"

        text = pat.sub(sub, text)
    return text, counts
