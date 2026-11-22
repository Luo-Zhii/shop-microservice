"""FinOps cho GenAI: ngân sách LLM theo ngày + hạ cấp có kiểm soát.

Mỗi lần chat: token (provider.last_usage) × bảng giá → USD, cộng dồn vào Postgres `llm_usage` theo ngày giờ VN (dùng chung
mọi replica — ngân sách không nhân theo số pod). Khi:
  • đã tiêu ≥ LLM_DAILY_BUDGET_USD, hoặc
  • kill switch `llm-assistant` (GitOps flags.yaml) tắt,
thì `available = False` → mọi nơi gọi tự rơi về nhánh luật/FAQ/template SẴN CÓ (không sửa từng tính năng).
Tính năng `critical` (kiểm duyệt nội dung) KHÔNG bị ngân sách chặn — hết tiền không được làm tắt lớp an toàn — nhưng
vẫn được tính chi phí. Tổng chi đọc lại từ DB tối đa mỗi `cache_s` giây (không truy vấn DB mỗi request).
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

from ..flags import is_enabled
from ..observability import LLM_BUDGET_REMAINING, LLM_COST, LLM_DEGRADED, LLM_TOKENS
from .base import LLMError, LLMProvider

log = logging.getLogger("ai_service.budget")
VN = timezone(timedelta(hours=7))
CRITICAL = {"moderation"}
FLAG = "llm-assistant"


class BudgetGuard:
    def __init__(self, inner: LLMProvider, store, price_in_per_mtok: float, price_out_per_mtok: float,
                 daily_budget_usd: float = 0.0, service: str = "ai-service", clock=time.time, cache_s: float = 10.0):
        self.inner, self.store, self.service, self.clock, self.cache_s = inner, store, service, clock, cache_s
        self.price_in, self.price_out, self.budget = price_in_per_mtok, price_out_per_mtok, daily_budget_usd
        self._spent, self._spent_at, self._spent_day = 0.0, -1e18, None

    def day(self):
        return datetime.fromtimestamp(self.clock(), VN).date()

    def spent(self, force: bool = False) -> float:
        d, now = self.day(), self.clock()
        if force or d != self._spent_day or now - self._spent_at >= self.cache_s:
            try:
                self._spent = sum(r["cost_usd"] for r in self.store.llm_usage(d))
            except Exception as e:  # noqa: BLE001 - DB lỗi: giữ số cũ, không chặn khách vì lỗi kế toán chi phí
                log.warning("không đọc được chi phí LLM: %s", e)
            self._spent_at, self._spent_day = now, d
        return self._spent

    def state(self) -> dict:
        """Trạng thái cho /llm/budget và metric: lý do hạ cấp (nếu có)."""
        spent = self.spent()
        reason = None
        if not self.inner.available:
            reason = "no_provider"
        elif not is_enabled(FLAG, True):
            reason = "kill_switch"
        elif self.budget > 0 and spent >= self.budget:
            reason = "budget_exhausted"
        remaining = None if self.budget <= 0 else max(0.0, 1 - spent / self.budget)
        if remaining is not None:
            LLM_BUDGET_REMAINING.labels(self.service).set(remaining)
        for r in ("kill_switch", "budget_exhausted"):
            LLM_DEGRADED.labels(self.service, r).set(1 if reason == r else 0)
        return {"day": str(self.day()), "spent_usd": round(spent, 6), "budget_usd": self.budget,
                "remaining_ratio": None if remaining is None else round(remaining, 4), "degraded": reason,
                "provider": self.inner.name, "price_per_mtok": {"input": self.price_in, "output": self.price_out}}

    def for_feature(self, feature: str) -> "_FeatureLLM":
        return _FeatureLLM(self, feature)

    def record(self, feature: str) -> float:
        u = self.inner.last_usage or {}
        tin, tout = int(u.get("input", 0)), int(u.get("output", 0))
        cost = tin / 1e6 * self.price_in + tout / 1e6 * self.price_out
        name = self.inner.name
        LLM_TOKENS.labels(self.service, name, feature, "input").inc(tin)
        LLM_TOKENS.labels(self.service, name, feature, "output").inc(tout)
        LLM_COST.labels(self.service, name, feature).inc(cost)
        try:
            self.store.add_llm_usage(self.day(), feature, name, tin, tout, cost)
        except Exception as e:  # noqa: BLE001
            log.warning("không ghi được chi phí LLM: %s", e)
        self._spent += cost
        return cost


class _FeatureLLM(LLMProvider):
    """Provider "nhìn" theo một tính năng: cùng giao diện LLMProvider để code gọi không phải đổi."""

    def __init__(self, guard: BudgetGuard, feature: str):
        self.g, self.feature = guard, feature
        self.name = guard.inner.name

    @property
    def available(self) -> bool:  # type: ignore[override]
        if not self.g.inner.available:
            return False
        if self.feature in CRITICAL:
            return True
        return self.g.state()["degraded"] is None

    def chat(self, messages, system=None, max_tokens=1024):
        if not self.available:
            raise LLMError(f"LLM đang hạ cấp ({self.g.state()['degraded']}) cho {self.feature}")
        self.g.inner.last_usage = None
        try:
            return self.g.inner.chat(messages, system=system, max_tokens=max_tokens)
        finally:
            if self.g.inner.last_usage is not None:   # lỗi sau khi đã tính token (vd refusal) vẫn phải trả tiền
                self.g.record(self.feature)

    def embed(self, texts):
        return self.g.inner.embed(texts)
