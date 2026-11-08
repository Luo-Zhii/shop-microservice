import datetime as dt
import json

import httpx
import pytest

from ai_service.chat import answer
from ai_service.engine import FaqIndex, load_faq
from ai_service.llm.base import (AnthropicProvider, BedrockProvider, LLMError, NoneProvider, OllamaProvider,
                                 build_provider)
from ai_service.llm.sigv4 import sign_request


def test_sigv4_matches_aws_documentation_example():
    # Ví dụ chính thức trong tài liệu AWS SigV4 (IAM ListUsers, 2015-08-30T12:36:00Z)
    h = sign_request("GET", "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
                     {"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"}, b"",
                     access_key="AKIDEXAMPLE", secret_key="wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                     region="us-east-1", service="iam",
                     now=dt.datetime(2015, 8, 30, 12, 36, tzinfo=dt.timezone.utc), include_content_sha=False)
    assert h["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, "
        "SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7")


def test_ollama_chat_and_embed():
    seen = []

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append((req.url.path, body))
        if req.url.path == "/api/chat":
            return httpx.Response(200, json={"message": {"role": "assistant", "content": " Xin chào "}})
        return httpx.Response(200, json={"embedding": [0.1, 0.2]})

    p = OllamaProvider("http://ollama:11434", "qwen2.5:3b", "nomic-embed-text", transport=httpx.MockTransport(handler))
    assert p.chat([{"role": "user", "content": "hi"}], system="sys") == "Xin chào"
    assert seen[0][1]["messages"][0] == {"role": "system", "content": "sys"} and seen[0][1]["stream"] is False
    assert p.embed(["a", "b"]) == [[0.1, 0.2], [0.1, 0.2]]


def test_anthropic_messages_api():
    def handler(req: httpx.Request):
        assert req.url.path == "/v1/messages"
        assert req.headers["x-api-key"] == "k" and req.headers["anthropic-version"] == "2026-10-21"
        body = json.loads(req.content)
        assert body["model"] == "claude-sonnet-5-5" and body["system"] == "sys"
        assert body["fallbacks"] == "default" and "temperature" not in body
        return httpx.Response(200, json={"stop_reason": "end_turn", "content": [
            {"type": "thinking", "thinking": ""}, {"type": "text", "text": "Trả lời"}]})

    p = AnthropicProvider("k", transport=httpx.MockTransport(handler))
    assert p.chat([{"role": "user", "content": "q"}], system="sys") == "Trả lời"


def test_anthropic_refusal_and_http_error():
    p = AnthropicProvider("k", transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={"stop_reason": "refusal", "content": []})))
    with pytest.raises(LLMError):
        p.chat([{"role": "user", "content": "q"}])
    p = AnthropicProvider("k", transport=httpx.MockTransport(lambda r: httpx.Response(529, text="overloaded")))
    with pytest.raises(LLMError, match="529"):
        p.chat([{"role": "user", "content": "q"}])


def test_bedrock_converse_signed():
    def handler(req: httpx.Request):
        assert req.url.raw_path.decode() == "/model/anthropic.claude-v2%3A1/converse"
        assert req.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=AK/")
        assert "/ap-southeast-1/bedrock/aws4_request" in req.headers["authorization"]
        assert req.headers["x-amz-security-token"] == "tok"
        body = json.loads(req.content)
        assert body["messages"][0]["content"][0]["text"] == "q" and body["system"][0]["text"] == "s"
        return httpx.Response(200, json={"output": {"message": {"content": [{"text": "OK"}]}}})

    p = BedrockProvider("ap-southeast-1", "AK", "SK", "tok", model_id="anthropic.claude-v2:1",
                        transport=httpx.MockTransport(handler))
    assert p.chat([{"role": "user", "content": "q"}], system="s") == "OK"


def test_build_provider_from_env():
    assert isinstance(build_provider(env={"LLM_PROVIDER": "none"}), NoneProvider)
    assert isinstance(build_provider(env={"LLM_PROVIDER": "ollama"}), OllamaProvider)
    with pytest.raises(LLMError):
        build_provider(env={"LLM_PROVIDER": "anthropic"})  # thiếu key
    with pytest.raises(LLMError):
        build_provider(env={"LLM_PROVIDER": "gpt"})


def test_chat_uses_llm_with_context_and_falls_back():
    from ai_service.config import Settings

    faq = FaqIndex.build(load_faq(Settings().faq_path))
    captured = {}

    def ok(req):
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json={"message": {"content": "Bạn có 7 ngày để trả hàng."}})

    llm = OllamaProvider("http://x", "m", "e", transport=httpx.MockTransport(ok))
    r = answer("trả hàng thế nào", [], faq, None, llm)
    assert r["provider"] == "ollama" and "[FAQ return-policy]" in captured["body"]["messages"][-1]["content"]
    bad = OllamaProvider("http://x", "m", "e", transport=httpx.MockTransport(lambda q: httpx.Response(500)))
    r = answer("trả hàng thế nào", [], faq, None, bad)
    assert r["provider"] == "none" and "7 ngày" in r["reply"]
