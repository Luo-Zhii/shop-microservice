"""FinOps cho GenAI: token → USD theo bảng giá, cộng dồn theo ngày VN; hết ngân sách / kill switch → chat & mô tả rơi về
luật/FAQ (không lỗi), kiểm duyệt vẫn dùng LLM; sang ngày mới thì mở lại; chỉ số qua /llm/budget."""

import json

from fastapi.testclient import TestClient

from ai_service.app import create_app
from ai_service.config import Settings
from ai_service.llm.base import LLMProvider
from ai_service.llm.budget import BudgetGuard
from ai_service.store import MemoryStore

DAY0 = 1_800_000_000.0   # 2027-01-15 ~ 14:40 giờ VN


class FakeLLM(LLMProvider):
    name = "fake"

    def __init__(self):
        self.calls = 0

    def chat(self, messages, system=None, max_tokens=1024):
        self.calls += 1
        self.last_usage = {"input": 1000, "output": 200}      # 1000×3/1e6 + 200×15/1e6 = 0.006 USD
        if "moderation" in (system or "").lower() or "<text>" in messages[-1]["content"]:
            return json.dumps({"labels": [], "score": 0.0})
        return "Trả lời từ LLM"


def test_budget_degrades_chat_but_not_moderation():
    t = {"now": DAY0}
    llm, store = FakeLLM(), MemoryStore()
    g = BudgetGuard(llm, store, 3, 15, daily_budget_usd=0.01, clock=lambda: t["now"], cache_s=0)
    chat = g.for_feature("chat")
    assert chat.available and chat.chat([{"role": "user", "content": "hi"}]) == "Trả lời từ LLM"
    chat.chat([{"role": "user", "content": "hi"}])
    st = g.state()
    assert st["spent_usd"] == 0.012 and st["degraded"] == "budget_exhausted" and st["remaining_ratio"] == 0
    assert chat.available is False
    mod = g.for_feature("moderation")
    assert mod.available is True                                   # hết tiền không được tắt lớp an toàn
    mod.chat([{"role": "user", "content": "<text>x</text>"}])
    usage = {r["feature"]: r for r in store.llm_usage(g.day())}
    assert usage["chat"]["calls"] == 2 and usage["chat"]["input_tokens"] == 2000 and usage["moderation"]["calls"] == 1
    t["now"] = DAY0 + 86400                                        # sang ngày mới (giờ VN) → mở lại
    assert g.state()["degraded"] is None and chat.available


def test_kill_switch_and_cost_recorded_even_on_error(tmp_path, monkeypatch):
    f = tmp_path / "flags.json"
    f.write_text(json.dumps({"flags": {"llm-assistant": {"state": "ENABLED", "variants": {"on": True, "off": False}, "defaultVariant": "off"}}}))
    monkeypatch.setenv("FLAGS_FILE", str(f))
    g = BudgetGuard(FakeLLM(), MemoryStore(), 3, 15, clock=lambda: DAY0 + 10)
    assert g.state()["degraded"] == "kill_switch" and g.for_feature("chat").available is False
    monkeypatch.setenv("FLAGS_FILE", str(tmp_path / "khong-co.json"))

    class Refuse(FakeLLM):
        def chat(self, messages, system=None, max_tokens=1024):
            self.last_usage = {"input": 500, "output": 0}
            from ai_service.llm.base import LLMError
            raise LLMError("refusal")

    store = MemoryStore()
    g2 = BudgetGuard(Refuse(), store, 3, 15, clock=lambda: DAY0)
    try:
        g2.for_feature("chat").chat([{"role": "user", "content": "x"}])
    except Exception:
        pass
    assert store.llm_usage(g2.day())[0]["input_tokens"] == 500     # bị từ chối vẫn tốn token → vẫn tính tiền


def test_api_falls_back_to_faq_when_budget_exhausted(monkeypatch):
    monkeypatch.setenv("LLM_DAILY_BUDGET_USD", "0.005")
    monkeypatch.setenv("DATABASE_URL", "memory://")
    monkeypatch.setenv("KAFKA_ENABLED", "false")
    llm = FakeLLM()
    with TestClient(create_app(Settings(), store=MemoryStore(), llm=llm)) as c:
        r1 = c.post("/chat", json={"message": "phí vận chuyển bao nhiêu", "history": []}).json()
        assert r1["provider"] == "fake"
        r2 = c.post("/chat", json={"message": "phí vận chuyển bao nhiêu", "history": []}).json()
        assert r2["provider"] != "fake" and r2["reply"]               # rơi về FAQ, khách vẫn có câu trả lời
        b = c.get("/llm/budget").json()
        assert b["degraded"] == "budget_exhausted" and b["usage"][0]["calls"] == 1 and llm.calls == 1
        m = c.get("/metrics").text
        import re   # counter toàn cục (cộng dồn qua các test) → chỉ kiểm có mặt và dương
        cost = re.search(r'ai_llm_cost_usd_total\{feature="chat",provider="fake",service="ai-service"\} ([0-9.e-]+)', m)
        assert cost and float(cost.group(1)) >= 0.006
        assert 'ai_llm_degraded{reason="budget_exhausted",service="ai-service"} 1.0' in m
