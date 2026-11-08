"""Phân loại lỗi CI theo luật (dùng khi LLM_PROVIDER=none, và làm gợi ý cho LLM)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
GH_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?")


@dataclass
class Rule:
    category: str
    title: str
    patterns: list[str]
    advice: list[str]
    weight: float = 1.0
    compiled: list[re.Pattern] = field(default_factory=list)

    def __post_init__(self):
        self.compiled = [re.compile(p, re.I | re.M) for p in self.patterns]


RULES = [
    Rule("oom", "Hết bộ nhớ (OOM)",
         [r"JavaScript heap out of memory", r"FATAL ERROR: .*Allocation failed", r"exit code 137", r"\bOOMKilled\b",
          r"Killed\s*$", r"Cannot allocate memory", r"MemoryError"],
         ["Tăng heap: `NODE_OPTIONS=--max-old-space-size=4096` hoặc runner nhiều RAM hơn.",
          "Giảm song song (`--maxWorkers=2`, `pnpm -r --workspace-concurrency=2`), chia nhỏ job.",
          "Kiểm tra rò rỉ bộ nhớ trong test (mock không được dọn, server không đóng)."], 1.3),
    Rule("missing_secret", "Thiếu secret / biến môi trường",
         [r"Input required and not supplied", r"secret\S* (?:is )?(?:not set|missing|empty)",
          r"Credentials could not be loaded", r"Unable to locate credentials", r"Error: .*(?:token|api key).*(?:required|missing)",
          r"environment variable .* (?:is )?(?:not set|missing|required)", r"denied: requested access to the resource is denied",
          r"unauthorized: authentication required", r"Bad credentials"],
         ["Kiểm tra secret đã khai báo ở Settings → Secrets and variables → Actions (đúng environment).",
          "PR từ fork không đọc được secret — dùng `pull_request_target` cẩn thận hoặc bỏ qua bước cần secret.",
          "Với registry/cloud: kiểm tra OIDC (`permissions: id-token: write`) và role/trust policy."], 1.2),
    Rule("vulnerability", "Lỗ hổng bảo mật (Trivy / audit)",
         [r"Total: \d+ \((?:UNKNOWN: \d+, )?(?:LOW: \d+, )?(?:MEDIUM: \d+, )?HIGH: [1-9]", r"CRITICAL: [1-9]",
          r"\bCVE-\d{4}-\d{4,}\b", r"found \d+ vulnerabilit", r"GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}"],
         ["Nâng phiên bản gói/base image theo cột Fixed Version của Trivy (vd `python:3.13-slim` bản mới, `apk upgrade`).",
          "Nếu chưa có bản vá: ghi ngoại lệ có thời hạn trong `.trivyignore` kèm lý do, không tắt cả bước quét.",
          "Chạy lại `trivy image --severity HIGH,CRITICAL <image>` cục bộ để xác nhận."], 1.1),
    Rule("typecheck", "Lỗi kiểm tra kiểu (TypeScript / mypy)",
         [r"error TS\d{4}:", r"Found \d+ errors? in\b", r"\btsc\b.*exited with", r"error: Incompatible types",
          r"mypy.*error:"],
         ["Chạy `pnpm -r typecheck` (hoặc `tsc --noEmit -p <pkg>`) cục bộ, sửa theo file:dòng trong log.",
          "Nếu lỗi ở `@shopnow/contracts`, kiểm tra service đã cập nhật theo kiểu mới trong packages/contracts."], 1.0),
    Rule("test_failure", "Test thất bại",
         [r"^\s*FAIL\s+\S+", r"Tests?:\s+\d+ failed", r"\d+ failed(?:,| in )", r"AssertionError", r"Expected:.*\n\s*Received:",
          r"^FAILED .*::", r"✗|×\s", r"--- FAIL:"],
         ["Chạy lại riêng test lỗi cục bộ (`pnpm --filter <svc> test -- -t \"<tên>\"` hoặc `pytest -k`).",
          "Test chập chờn (timeout, thứ tự)? Kiểm tra phụ thuộc thời gian/mạng, cô lập DB test.",
          "Nếu thay đổi hợp đồng API/sự kiện có chủ đích, cập nhật test và docs/architecture.md cùng PR."], 1.0),
    Rule("lint", "Lỗi lint / format",
         [r"\d+ problems? \(\d+ errors?", r"eslint.*error", r"Prettier.*(?:check|differ)", r"would reformat", r"ruff.*error",
          r"Code style issues found"],
         ["Chạy `pnpm lint --fix` / `prettier --write` / `ruff check --fix` rồi commit lại."], 0.9),
    Rule("dependency", "Lỗi cài đặt phụ thuộc",
         [r"ERR_PNPM_\w+", r"npm ERR!", r"lockfile.*(?:not up to date|outdated|needs to be updated)",
          r"Could not find a version that satisfies", r"No matching distribution found", r"ResolutionImpossible",
          r"go: .* (?:unknown revision|missing go.sum entry)"],
         ["Đồng bộ lockfile: `pnpm install` rồi commit `pnpm-lock.yaml` (CI dùng --frozen-lockfile).",
          "Kiểm tra phiên bản gói có tồn tại/được pin đúng; registry có bị chặn mạng không."], 1.0),
    Rule("build", "Lỗi build / biên dịch",
         [r"Module not found", r"Cannot find module", r"SyntaxError:", r"error: could not compile", r"undefined: \w+",
          r"Build failed", r"failed to solve:", r"ERROR \[.*\] RUN", r"exit code: [1-9]\d*"],
         ["Đọc lỗi đầu tiên trong log (lỗi sau thường là hệ quả).",
          "Docker build: kiểm tra `COPY` đúng đường dẫn so với context, file có bị `.dockerignore` loại không."], 0.8),
    Rule("network", "Lỗi mạng / dịch vụ ngoài",
         [r"ETIMEDOUT", r"ECONNRESET", r"ECONNREFUSED", r"getaddrinfo ENOTFOUND", r"TLS handshake timeout",
          r"429 Too Many Requests", r"rate limit", r"503 Service Unavailable", r"i/o timeout"],
         ["Thường là tạm thời — chạy lại job; nếu lặp lại, thêm retry/cache phụ thuộc.",
          "Test phụ thuộc dịch vụ ngoài: dùng mock hoặc service container trong workflow."], 0.7),
    Rule("permission", "Thiếu quyền GitHub token / cluster",
         [r"Resource not accessible by integration", r"403 Forbidden", r"permission denied", r"forbidden: User .* cannot"],
         ["Thêm `permissions:` phù hợp cho job (vd `pull-requests: write`, `packages: write`, `id-token: write`).",
          "Kubernetes: kiểm tra RBAC của service account dùng để deploy."], 0.9),
    Rule("timeout", "Hết thời gian",
         [r"The job running on runner .* has exceeded the maximum execution time", r"Timeout of \d+ms exceeded",
          r"timed out after", r"context deadline exceeded"],
         ["Tìm bước chậm (cache phụ thuộc, test treo do không đóng kết nối), tăng `timeout-minutes` nếu hợp lý."], 0.8),
]


def clean(text: str) -> list[str]:
    return [GH_PREFIX.sub("", ANSI.sub("", ln)).rstrip() for ln in text.splitlines()]


def classify(lines: list[str]) -> list[dict]:
    joined = "\n".join(lines)
    out = []
    for r in RULES:
        hits: list[int] = []
        for p in r.compiled:
            for m in p.finditer(joined):
                hits.append(joined.count("\n", 0, m.start()))
        if hits:
            ln = sorted(set(hits))
            out.append({"category": r.category, "title": r.title, "hits": len(ln),
                        "confidence": round(min(0.95, (0.4 + 0.15 * min(len(ln), 4)) * min(r.weight, 1.0)), 2),
                        "first_line": ln[0] + 1, "lines": ln[:20], "advice": r.advice})
    # Job CI chạy tuần tự: lỗi xuất hiện SỚM nhất thường là nguyên nhân gốc, lỗi sau là hệ quả/bước khác.
    # Loại yếu (mạng, build chung chung) chỉ đứng đầu khi không có loại mạnh nào.
    out.sort(key=lambda c: (c["confidence"] < 0.5, c["first_line"], -c["confidence"]))
    return out


ERROR_HINT = re.compile(r"(?i)(error|fail|fatal|exception|denied|cannot|not found|killed|panic|traceback|critical|##\[error\])")


def error_excerpt(lines: list[str], focus: list[int], context: int = 3, max_lines: int = 160) -> list[str]:
    """Các đoạn quanh dòng lỗi (ưu tiên dòng khớp luật), gộp chồng lấn, cắt độ dài."""
    marks = sorted(set(focus) | {i for i, ln in enumerate(lines) if ERROR_HINT.search(ln)})
    if not marks:
        return lines[-min(len(lines), 60):]
    ranges: list[list[int]] = []
    for i in marks:
        lo, hi = max(0, i - context), min(len(lines), i + context + 1)
        if ranges and lo <= ranges[-1][1]:
            ranges[-1][1] = max(ranges[-1][1], hi)
        else:
            ranges.append([lo, hi])
    out: list[str] = []
    for lo, hi in ranges:
        if out:
            out.append("…")
        out.extend(f"{i + 1:>5} | {lines[i]}" for i in range(lo, hi))
        if len(out) >= max_lines:
            out = out[:max_lines] + ["… (cắt bớt)"]
            break
    return out
