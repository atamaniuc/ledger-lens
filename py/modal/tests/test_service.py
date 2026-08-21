"""The end-to-end request flow with the Modal runtime stubbed (spec 0009).

No Modal account, no network: the transcriber is the deterministic stub and
the webhook POST is a captured fake. These tests prove the producer side of
the pipeline — right URL, right signature, right idempotency key — which is
what Modal must get right before the Edge Function even sees a request.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import pytest

from modal_transcription import callback, idempotency, service
from modal_transcription.config import Settings
from modal_transcription.contract import Transcript, TranscriptSegment
from modal_transcription.transcriber import StubTranscriber

ORG_A = "00000000-0000-4000-8000-000000000001"
AUDIO = b"RIFF....WAVEinterview-bytes"
SETTINGS = Settings(
    supabase_url="https://example.supabase.co",
    webhook_shared_secret="test-secret",
    webhook_url="https://example.supabase.co/functions/v1/transcribe-webhook",
)


@dataclass
class FakeResponse:
    status_code: int
    text: str


class FakePost:
    """Captures every webhook call; returns the webhook's would-be answer."""

    def __init__(self, status_code: int = 200, body: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, str], str]] = []
        self.status_code = status_code
        self.body = body if body is not None else {"status": "succeeded"}

    def __call__(self, url: str, headers: dict[str, str], raw_body: str) -> FakeResponse:
        self.calls.append((url, headers, raw_body))
        return FakeResponse(self.status_code, json.dumps(self.body))


def test_happy_path_posts_a_signed_request_to_the_webhook() -> None:
    post = FakePost()
    result = service.handle_transcribe_request(ORG_A, AUDIO, settings=SETTINGS, post=post)
    assert result["status_code"] == 200
    assert result["body"]["status"] == "succeeded"
    assert len(post.calls) == 1
    url, headers, raw_body = post.calls[0]
    assert url == "https://example.supabase.co/functions/v1/transcribe-webhook"
    assert headers["content-type"] == "application/json"
    # The body on the wire is exactly what the signature covers.
    assert (
        callback.sign(
            SETTINGS.webhook_shared_secret,
            int(headers["x-webhook-timestamp"]),
            headers["x-webhook-nonce"],
            raw_body,
        )
        == headers["x-webhook-signature"]
    )


def test_payload_carries_org_source_and_content_key() -> None:
    post = FakePost()
    service.handle_transcribe_request(ORG_A, AUDIO, settings=SETTINGS, post=post)
    body = json.loads(post.calls[0][2])
    assert body["org_id"] == ORG_A
    assert body["source"] == "transcription"
    event = body["event"]
    assert event["audio_hash"] == idempotency.audio_id(AUDIO)
    assert event["transcript"]["text"]
    assert event["transcript"]["segments"][0]["start"] == 0.0


def test_same_audio_twice_produces_the_same_content_key() -> None:
    """AC-02 on the producer side: redelivering the same audio must build the
    same idempotency key, so the webhook's dedup sees one transcript."""
    first = FakePost()
    second = FakePost()
    a = service.handle_transcribe_request(ORG_A, AUDIO, settings=SETTINGS, post=first)
    b = service.handle_transcribe_request(ORG_A, AUDIO, settings=SETTINGS, post=second)
    assert a["audio_hash"] == b["audio_hash"]
    assert a["raw_body_sent"] == b["raw_body_sent"]
    body_a = json.loads(first.calls[0][2])
    body_b = json.loads(second.calls[0][2])
    assert body_a["event"]["transcript"]["text"] == body_b["event"]["transcript"]["text"]


def test_rejects_bad_org_id_before_any_post() -> None:
    post = FakePost()
    with pytest.raises(service.TranscribeRequestError, match="org_id must be a uuid"):
        service.handle_transcribe_request("acme", AUDIO, settings=SETTINGS, post=post)
    assert post.calls == []


def test_rejects_empty_audio() -> None:
    post = FakePost()
    with pytest.raises(service.TranscribeRequestError, match="audio is empty"):
        service.handle_transcribe_request(ORG_A, b"", settings=SETTINGS, post=post)
    assert post.calls == []


def test_rejects_oversized_audio_with_413() -> None:
    post = FakePost()
    settings = Settings(
        supabase_url="https://example.supabase.co",
        webhook_shared_secret="test-secret",
        webhook_url="https://example.supabase.co/functions/v1/transcribe-webhook",
        max_audio_bytes=10,
    )
    with pytest.raises(service.TranscribeRequestError) as exc:
        service.handle_transcribe_request(ORG_A, AUDIO, settings=settings, post=post)
    assert exc.value.status_code == 413
    assert "MODAL_MAX_AUDIO_BYTES" in exc.value.message
    assert post.calls == []


class FutureDatedTranscriber:
    """A transcriber that claims the recording happened tomorrow — the producer
    must refuse to send it rather than let the webhook quarantine it."""

    model_name = "test-future"

    def transcribe(self, audio: bytes) -> Transcript:
        tomorrow = date.today() + timedelta(days=1)
        text = "Recorded in the future."
        return Transcript(
            text=text,
            language="en",
            segments=(TranscriptSegment(start=0.0, end=1.0, text=text),),
            recorded_at=tomorrow,
            duration_seconds=1.0,
        )


def test_producer_refuses_an_impossible_future_recorded_at() -> None:
    post = FakePost()
    with pytest.raises(service.TranscribeRequestError, match="future_dated"):
        service.handle_transcribe_request(
            ORG_A, AUDIO, settings=SETTINGS, post=post, transcriber=FutureDatedTranscriber()
        )
    assert post.calls == []


def test_stub_transcriber_is_deterministic_across_instances() -> None:
    t1 = StubTranscriber().transcribe(AUDIO)
    t2 = StubTranscriber().transcribe(AUDIO)
    assert t1 == t2
    assert t1.recorded_at == t2.recorded_at
