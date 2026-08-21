"""Signed webhook construction for the Modal -> Supabase callback (spec 0009).

Reuses the exact scheme of spec 0004 / D-19
(supabase/functions/_shared/signature.ts): HMAC-SHA256 over the canonical
string

    v1:<timestamp_ms>:<nonce>:<rawBody>

sent in the x-webhook-timestamp / x-webhook-nonce / x-webhook-signature
headers, where `rawBody` is the exact byte string that goes on the wire —
never a re-serialization. The Edge Function additionally enforces a 5-minute
freshness window and a single-use nonce held in Postgres, so an unsigned or
replayed callback is refused before anything is read or written.

The known-answer test vector in tests/test_callback.py is computed with the
real Deno verifier (signature.ts), so this module is checked against the
scheme, not against itself.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from typing import Any
from uuid import uuid4

SIGNATURE_VERSION = "v1"
_NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")

# Default header names, matching the Edge Functions' extractSignatureHeaders.
HEADER_TIMESTAMP = "x-webhook-timestamp"
HEADER_NONCE = "x-webhook-nonce"
HEADER_SIGNATURE = "x-webhook-signature"
HEADER_CORRELATION_ID = "x-correlation-id"


def canonical_string(timestamp_ms: int, nonce: str, raw_body: str) -> str:
    return f"{SIGNATURE_VERSION}:{timestamp_ms}:{nonce}:{raw_body}"


def sign(secret: str, timestamp_ms: int, nonce: str, raw_body: str) -> str:
    """HMAC-SHA256 of the canonical string, hex — same as Web Crypto's
    crypto.subtle.sign with SHA-256 in signature.ts."""
    message = canonical_string(timestamp_ms, nonce, raw_body).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def new_nonce() -> str:
    """A nonce the Edge Function's NONCE_RE will accept (8-128 [A-Za-z0-9_-])."""
    return uuid4().hex + secrets.token_urlsafe(12)


def build_signed_request(
    payload: dict[str, Any],
    secret: str,
    *,
    timestamp_ms: int | None = None,
    nonce: str | None = None,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Build the request a caller sends to the transcribe-webhook function.

    The body is serialized exactly once and the signature covers those exact
    bytes; sending anything else (e.g. re-serializing the dict on the wire)
    would fail the HMAC check. Returns the wire-ready pieces:

        {"raw_body": str, "headers": {str: str}}

    plus "canonical" for tests and observability.
    """
    raw_body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    ts = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
    nonce_value = nonce if nonce is not None else new_nonce()
    if not _NONCE_RE.match(nonce_value):
        raise ValueError(f"nonce must match {_NONCE_RE.pattern}")

    headers = {
        "content-type": "application/json",
        HEADER_TIMESTAMP: str(ts),
        HEADER_NONCE: nonce_value,
        HEADER_SIGNATURE: sign(secret, ts, nonce_value, raw_body),
    }
    if correlation_id is not None:
        headers[HEADER_CORRELATION_ID] = correlation_id

    return {
        "raw_body": raw_body,
        "headers": headers,
        "canonical": canonical_string(ts, nonce_value, raw_body),
        "timestamp_ms": ts,
        "nonce": nonce_value,
    }
