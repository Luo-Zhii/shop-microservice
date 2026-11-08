"""Adapter LLM dùng chung với ai-service (bản sao của services/ai-service/ai_service/llm — giữ đồng bộ)."""

from .base import ChatMessage, LLMError, LLMProvider, NoneProvider, build_provider

__all__ = ["ChatMessage", "LLMError", "LLMProvider", "NoneProvider", "build_provider"]
