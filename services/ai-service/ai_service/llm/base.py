"""Nhà cung cấp LLM qua HTTP thuần (httpx). `none` = không có LLM, nơi gọi tự dùng luật/template.

Biến môi trường:
  LLM_PROVIDER=none|ollama|bedrock|anthropic, LLM_TIMEOUT_SECONDS (30)
  ollama:    OLLAMA_URL (http://localhost:11434), OLLAMA_MODEL (qwen2.5:3b), OLLAMA_EMBED_MODEL (nomic-embed-text)
  anthropic: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (claude-sonnet-5-5), ANTHROPIC_BASE_URL, ANTHROPIC_EFFORT (low),
             ANTHROPIC_FALLBACKS (true)
  bedrock:   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN?,
             BEDROCK_MODEL_ID (anthropic.claude-sonnet-5-5), BEDROCK_EMBED_MODEL_ID (amazon.titan-embed-text-v2:0)
"""

from __future__ import annotations

import json
import os
from typing import Mapping, TypedDict
from urllib.parse import quote

import httpx

from .sigv4 import sign_request


class ChatMessage(TypedDict):
    role: str  # "user" | "assistant"
    content: str


class LLMError(RuntimeError):
    pass


class LLMProvider:
    name = "base"
    available = True

    def chat(self, messages: list[ChatMessage], system: str | None = None, max_tokens: int = 1024) -> str:
        raise NotImplementedError

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise LLMError(f"{self.name} không hỗ trợ embedding")

    def close(self) -> None:  # pragma: no cover - mặc định không giữ tài nguyên
        pass


class NoneProvider(LLMProvider):
    name = "none"
    available = False

    def chat(self, messages, system=None, max_tokens=1024):
        raise LLMError("LLM_PROVIDER=none")


class _HttpProvider(LLMProvider):
    def __init__(self, base_url: str, timeout: float, transport: httpx.BaseTransport | None = None):
        self.client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def _post(self, path: str, payload: dict, headers: dict[str, str] | None = None) -> dict:
        try:
            r = self.client.post(path, json=payload, headers=headers)
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name}: lỗi kết nối: {e}") from e
        if r.status_code >= 400:
            raise LLMError(f"{self.name}: HTTP {r.status_code}: {r.text[:300]}")
        return r.json()

    def close(self) -> None:
        self.client.close()


class OllamaProvider(_HttpProvider):
    name = "ollama"

    def __init__(self, base_url: str, model: str, embed_model: str, timeout: float = 30, transport=None):
        super().__init__(base_url, timeout, transport)
        self.model, self.embed_model = model, embed_model

    def chat(self, messages, system=None, max_tokens=1024):
        msgs = ([{"role": "system", "content": system}] if system else []) + list(messages)
        data = self._post(
            "/api/chat",
            {"model": self.model, "messages": msgs, "stream": False, "options": {"num_predict": max_tokens}},
        )
        try:
            return data["message"]["content"].strip()
        except (KeyError, TypeError) as e:
            raise LLMError(f"ollama: phản hồi lạ: {data!r}"[:300]) from e

    def embed(self, texts):
        out = []
        for t in texts:
            data = self._post("/api/embeddings", {"model": self.embed_model, "prompt": t})
            if "embedding" not in data:
                raise LLMError("ollama: thiếu trường embedding")
            out.append([float(x) for x in data["embedding"]])
        return out


class AnthropicProvider(_HttpProvider):
    """Messages API (POST /v1/messages) gọi thẳng HTTP theo yêu cầu dự án (không cài SDK)."""

    name = "anthropic"
    API_VERSION = "2026-10-21"

    def __init__(self, api_key: str, model: str = "claude-sonnet-5-5", base_url: str = "https://api.anthropic.com",
                 effort: str | None = "low", timeout: float = 60, transport=None, fallbacks: bool = True):
        super().__init__(base_url, timeout, transport)
        if not api_key:
            raise LLMError("anthropic: thiếu ANTHROPIC_API_KEY")
        self.api_key, self.model, self.effort, self.fallbacks = api_key, model, effort, fallbacks

    def chat(self, messages, system=None, max_tokens=1024):
        payload: dict = {"model": self.model, "max_tokens": max_tokens, "messages": list(messages)}
        if system:
            payload["system"] = system
        if self.effort:
            payload["output_config"] = {"effort": self.effort}
        headers = {"x-api-key": self.api_key, "anthropic-version": self.API_VERSION, "content-type": "application/json"}
        if self.fallbacks:
            # Bộ phân loại an toàn từ chối → máy chủ tự chạy lại trên mô hình dự phòng (ANTHROPIC_FALLBACKS=false để tắt).
            payload["fallbacks"] = "default"
            headers["anthropic-beta"] = "server-side-fallback-2026-07-01"
        data = self._post("/v1/messages", payload, headers=headers)
        if data.get("stop_reason") == "refusal":
            raise LLMError("anthropic: mô hình từ chối trả lời (stop_reason=refusal)")
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if not text:
            raise LLMError("anthropic: phản hồi không có khối text")
        return text


class BedrockProvider(_HttpProvider):
    """Bedrock Runtime Converse API, ký SigV4 bằng tay (boto3 không cài để giữ image nhỏ)."""

    name = "bedrock"

    def __init__(self, region: str, access_key: str, secret_key: str, session_token: str | None = None,
                 model_id: str = "anthropic.claude-sonnet-5-5", embed_model_id: str = "amazon.titan-embed-text-v2:0",
                 timeout: float = 60, transport=None, endpoint: str | None = None):
        if not (region and access_key and secret_key):
            raise LLMError("bedrock: thiếu AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY")
        self.endpoint = endpoint or f"https://bedrock-runtime.{region}.amazonaws.com"
        super().__init__(self.endpoint, timeout, transport)
        self.region, self.access_key, self.secret_key, self.session_token = region, access_key, secret_key, session_token
        self.model_id, self.embed_model_id = model_id, embed_model_id

    def _signed_post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode()
        url = self.endpoint + path
        headers = sign_request(
            "POST", url, {"content-type": "application/json", "accept": "application/json"}, body,
            access_key=self.access_key, secret_key=self.secret_key, region=self.region,
            service="bedrock", session_token=self.session_token,
        )
        headers.pop("host", None)
        try:
            r = self.client.post(path, content=body, headers=headers)
        except httpx.HTTPError as e:
            raise LLMError(f"bedrock: lỗi kết nối: {e}") from e
        if r.status_code >= 400:
            raise LLMError(f"bedrock: HTTP {r.status_code}: {r.text[:300]}")
        return r.json()

    def chat(self, messages, system=None, max_tokens=1024):
        payload: dict = {
            "messages": [{"role": m["role"], "content": [{"text": m["content"]}]} for m in messages],
            "inferenceConfig": {"maxTokens": max_tokens},
        }
        if system:
            payload["system"] = [{"text": system}]
        data = self._signed_post(f"/model/{quote(self.model_id, safe='')}/converse", payload)
        try:
            blocks = data["output"]["message"]["content"]
        except (KeyError, TypeError) as e:
            raise LLMError("bedrock: phản hồi Converse lạ") from e
        text = "".join(b.get("text", "") for b in blocks).strip()
        if not text:
            raise LLMError("bedrock: phản hồi rỗng")
        return text

    def embed(self, texts):
        out = []
        for t in texts:
            data = self._signed_post(f"/model/{quote(self.embed_model_id, safe='')}/invoke", {"inputText": t})
            if "embedding" not in data:
                raise LLMError("bedrock: thiếu embedding")
            out.append([float(x) for x in data["embedding"]])
        return out


def build_provider(name: str | None = None, env: Mapping[str, str] | None = None,
                   transport: httpx.BaseTransport | None = None) -> LLMProvider:
    env = os.environ if env is None else env
    name = (name or env.get("LLM_PROVIDER", "none")).strip().lower()
    timeout = float(env.get("LLM_TIMEOUT_SECONDS", "30"))
    if name in ("", "none", "off"):
        return NoneProvider()
    if name == "ollama":
        return OllamaProvider(env.get("OLLAMA_URL", "http://localhost:11434"), env.get("OLLAMA_MODEL", "qwen2.5:3b"),
                              env.get("OLLAMA_EMBED_MODEL", "nomic-embed-text"), timeout, transport)
    if name == "anthropic":
        return AnthropicProvider(env.get("ANTHROPIC_API_KEY", ""), env.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
                                 env.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
                                 env.get("ANTHROPIC_EFFORT", "low") or None, timeout, transport,
                                 env.get("ANTHROPIC_FALLBACKS", "true").lower() in ("1", "true", "yes"))
    if name == "bedrock":
        return BedrockProvider(env.get("AWS_REGION", env.get("AWS_DEFAULT_REGION", "")), env.get("AWS_ACCESS_KEY_ID", ""),
                               env.get("AWS_SECRET_ACCESS_KEY", ""), env.get("AWS_SESSION_TOKEN") or None,
                               env.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-5-5"),
                               env.get("BEDROCK_EMBED_MODEL_ID", "amazon.titan-embed-text-v2:0"), timeout, transport,
                               env.get("BEDROCK_ENDPOINT") or None)
    raise LLMError(f"LLM_PROVIDER không hợp lệ: {name}")


def safe_build_provider(log=None, **kw) -> LLMProvider:
    """Cấu hình sai (thiếu key…) → ghi cảnh báo và rơi về `none` thay vì làm sập service."""
    try:
        return build_provider(**kw)
    except LLMError as e:
        if log:
            log.warning("LLM provider lỗi cấu hình, dùng none: %s", e)
        return NoneProvider()
