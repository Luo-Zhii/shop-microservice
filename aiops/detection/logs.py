"""Phát hiện bất thường log bằng Drain3: trích template, phát hiện template LỖI mới và tần suất tăng đột biến.

Mỗi cửa sổ (vd 2 phút) đếm số dòng theo (service, template). Với template lỗi:
- mới: chưa từng thấy ở service sau giai đoạn khởi động (warmup cửa sổ) → điểm 0.6
- đột biến: z = (c − λ)/√(λ+1) với λ = EWMA số đếm các cửa sổ trước; z > 3 và c ≥ 5 → điểm sigmoid(z − 4)
Điểm service = 1 − Π(1 − s_i) ∈ [0..1].
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

from drain3 import TemplateMiner
from drain3.masking import MaskingInstruction
from drain3.template_miner_config import TemplateMinerConfig

MASKS = [
    (r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", "UUID"),
    (r"\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b", "IP"),
    (r"\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{16,}\b", "HEX"),
    (r"(?<=[^A-Za-z0-9])-?\d+(?:\.\d+)?(?:ms|s)?\b|^-?\d+(?:\.\d+)?\b", "NUM"),
]
ERROR_LEVELS = {"error", "fatal", "critical", "panic", "50", "60"}


def make_miner() -> TemplateMiner:
    cfg = TemplateMinerConfig()
    cfg.drain_sim_th = 0.4
    cfg.drain_depth = 4
    cfg.profiling_enabled = False
    cfg.masking_instructions = [MaskingInstruction(p, m) for p, m in MASKS]
    return TemplateMiner(config=cfg)


def parse_line(line: str) -> tuple[str, str | None]:
    """Dòng log (JSON pino/python hoặc text) → (message, level)."""
    s = line.strip()
    if s.startswith("{"):
        try:
            obj = json.loads(s)
            level = obj.get("level")
            msg = str(obj.get("msg") or obj.get("message") or "")
            err = obj.get("err")
            if isinstance(err, dict):
                msg += " " + str(err.get("type") or "") + " " + str(err.get("message") or "")[:200]
            elif isinstance(err, str):
                msg += " " + err.splitlines()[-1][:200] if err else ""
            return msg.strip(), (str(level).lower() if level is not None else None)
        except ValueError:
            pass
    return s, None


@dataclass
class LogFinding:
    service: str
    score: float
    new_templates: list[dict] = field(default_factory=list)
    spikes: list[dict] = field(default_factory=list)
    top_errors: list[dict] = field(default_factory=list)


class LogAnomalyDetector:
    def __init__(self, error_regex: str = r"(?i)(error|exception|fatal|panic|fail|timeout|refused)",
                 warmup_windows: int = 3, alpha: float = 0.2):
        self.miner = make_miner()
        self.error_re = re.compile(error_regex)
        self.warmup = warmup_windows
        self.alpha = alpha
        self.windows_seen: dict[str, int] = defaultdict(int)
        self.seen: dict[str, set[int]] = defaultdict(set)
        self.ewma: dict[tuple[str, int], float] = {}
        self.templates: dict[int, str] = {}

    def _is_error(self, msg: str, level: str | None) -> bool:
        if level is not None:
            return level in ERROR_LEVELS or (level in {"warn", "warning", "40"} and bool(self.error_re.search(msg)))
        return bool(self.error_re.search(msg))

    def observe(self, lines: list[tuple[str, str]], services: list[str] | None = None) -> dict[str, LogFinding]:
        """lines = [(service, raw_line)] của MỘT cửa sổ thời gian."""
        counts: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
        is_err: dict[int, bool] = {}
        for svc, raw in lines:
            msg, level = parse_line(raw)
            if not msg:
                continue
            r = self.miner.add_log_message(msg)
            cid = r["cluster_id"]
            self.templates[cid] = r["template_mined"]
            counts[svc][cid] += 1
            is_err[cid] = is_err.get(cid, False) or self._is_error(msg, level)
        out: dict[str, LogFinding] = {}
        for svc in set(counts) | set(services or []):
            c = counts.get(svc, {})
            warm = self.windows_seen[svc] >= self.warmup
            parts: list[float] = []
            f = LogFinding(svc, 0.0)
            for cid, n in c.items():
                if not is_err.get(cid):
                    continue
                f.top_errors.append({"template": self.templates[cid], "count": n})
                lam = self.ewma.get((svc, cid))
                if cid not in self.seen[svc]:
                    if warm:
                        f.new_templates.append({"template": self.templates[cid], "count": n})
                        parts.append(0.6 if n >= 2 else 0.4)
                elif lam is not None:
                    z = (n - lam) / math.sqrt(lam + 1.0)
                    if z > 3 and n >= 5:
                        f.spikes.append({"template": self.templates[cid], "count": n, "expected": round(lam, 2),
                                         "z": round(z, 2)})
                        parts.append(float(1 / (1 + math.exp(-(z - 4)))))
            # cập nhật baseline sau khi chấm điểm
            for cid in set(self.seen[svc]) | set(c):
                n = c.get(cid, 0)
                key = (svc, cid)
                self.ewma[key] = n if key not in self.ewma else (1 - self.alpha) * self.ewma[key] + self.alpha * n
            self.seen[svc] |= set(c)
            self.windows_seen[svc] += 1
            keep = 1.0
            for p in parts:
                keep *= 1 - p
            f.score = round(1 - keep, 4)
            f.top_errors.sort(key=lambda x: -x["count"])
            f.top_errors = f.top_errors[:5]
            out[svc] = f
        return out


def summarize_errors(lines: list[str], top: int = 5) -> list[dict]:
    """Gom log lỗi của một service thành top template (dùng trong bối cảnh sự cố)."""
    miner = make_miner()
    counts: dict[int, int] = defaultdict(int)
    tmpl: dict[int, str] = {}
    sample: dict[int, str] = {}
    for raw in lines:
        msg, _ = parse_line(raw)
        if not msg:
            continue
        r = miner.add_log_message(msg)
        counts[r["cluster_id"]] += 1
        tmpl[r["cluster_id"]] = r["template_mined"]
        sample.setdefault(r["cluster_id"], msg[:300])
    ranked = sorted(counts, key=lambda c: -counts[c])[:top]
    return [{"template": tmpl[c], "count": counts[c], "example": sample[c]} for c in ranked]
