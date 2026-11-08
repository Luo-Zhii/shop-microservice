"""AWS Signature Version 4 tự ký (không cần boto3) — đủ cho Bedrock Runtime qua httpx."""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
from urllib.parse import quote, urlsplit, parse_qsl


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _canonical_query(query: str) -> str:
    pairs = parse_qsl(query, keep_blank_values=True)
    enc = sorted((quote(k, safe="-_.~"), quote(v, safe="-_.~")) for k, v in pairs)
    return "&".join(f"{k}={v}" for k, v in enc)


def sign_request(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes,
    *,
    access_key: str,
    secret_key: str,
    region: str,
    service: str,
    session_token: str | None = None,
    now: _dt.datetime | None = None,
    include_content_sha: bool = True,
) -> dict[str, str]:
    """Trả về headers đã thêm x-amz-date, (x-amz-security-token), Authorization.

    `url` phải là URL thực gửi đi (path đã percent-encode một lần, vd `:` → `%3A`).
    Với dịch vụ khác S3, canonical URI encode thêm một lần nữa (giống botocore).
    """
    now = now or _dt.datetime.now(_dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    parts = urlsplit(url)
    out = {k: v for k, v in headers.items()}
    out["host"] = parts.netloc
    out["x-amz-date"] = amz_date
    payload_hash = hashlib.sha256(body).hexdigest()
    if include_content_sha:
        out["x-amz-content-sha256"] = payload_hash
    if session_token:
        out["x-amz-security-token"] = session_token

    lower = {k.lower().strip(): " ".join(str(v).strip().split()) for k, v in out.items()}
    signed_names = sorted(lower)
    canonical_headers = "".join(f"{k}:{lower[k]}\n" for k in signed_names)
    signed_headers = ";".join(signed_names)
    canonical_uri = quote(parts.path or "/", safe="/~")
    canonical_request = "\n".join(
        [method.upper(), canonical_uri, _canonical_query(parts.query), canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()]
    )
    k = _hmac(("AWS4" + secret_key).encode(), date_stamp)
    k = _hmac(k, region)
    k = _hmac(k, service)
    k = _hmac(k, "aws4_request")
    signature = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()
    out["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
    return out
