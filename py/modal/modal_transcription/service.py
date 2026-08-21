"""The transcription request flow, testable end to end without Modal (spec 0009).

This is the "same pipeline as everything else" glue: audio in, a timestamped
transcript out, delivered to the transcribe-webhook Edge Function as a signed
request whose `audio_hash` is the content idempotency key. The Edge
Function — not this module — decides written / duplicate / quarantined by
running the shared ingestion transform path, so Modal is a producer, never a
second pipeline.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

import httpx

from modal_transcription import callback, contract, idempotency
from modal_transcription.config import Settings, settings_from_env
from modal_transcription.transcriber import Transcriber, make_transcriber

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_SOURCE = "transcription"
_MODEL_STUB = "stub-whisper"


class TranscribeRequestError(Exception):
    """A client-side problem (bad org id, oversized audio, invalid transcript).
    Carries the HTTP status the web endpoint should answer with."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _post_httpx(url: str, headers: dict[str, str], raw_body: str) -> httpx.Response:
    return httpx.post(url, headers=headers, content=raw_body, timeout=60.0)


def build_event(
    transcript: contract.Transcript,
    audio_hash: str,
    model: str,
) -> dict[str, Any]:
    """The webhook payload body minus org_id/source — what raw_events.payload
    will hold, and what the producer-side contract validates."""
    return {
        "audio_hash": audio_hash,
        "recorded_at": transcript.recorded_at.isoformat(),
        "duration_seconds": transcript.duration_seconds,
        "model": model,
        "transcript": {
            "text": transcript.text,
            "language": transcript.language,
            "segments": [
                {"start": seg.start, "end": seg.end, "text": seg.text}
                for seg in transcript.segments
            ],
        },
    }


def handle_transcribe_request(
    org_id: str,
    audio_bytes: bytes,
    *,
    settings: Settings | None = None,
    post: Callable[[str, dict[str, str], str], Any] | None = None,
    transcriber: Transcriber | None = None,
) -> dict[str, Any]:
    """Transcribe one audio document and deliver it to the pipeline.

    Returns the webhook response shape ({status_code, body, audio_hash}).
    Deterministic for a given audio + backend, which is what the idempotency
    tests rely on.
    """
    settings = settings or settings_from_env()
    post = post or _post_httpx

    if not _UUID_RE.match(org_id):
        raise TranscribeRequestError("org_id must be a uuid")
    if len(audio_bytes) == 0:
        raise TranscribeRequestError("audio is empty")
    if len(audio_bytes) > settings.max_audio_bytes:
        raise TranscribeRequestError(
            "audio is "
            f"{len(audio_bytes)} bytes; the cap is {settings.max_audio_bytes} "
            "(MODAL_MAX_AUDIO_BYTES)",
            status_code=413,
        )

    audio_hash = idempotency.audio_id(audio_bytes)
    backend = transcriber or make_transcriber(
        {"MODAL_TRANSCRIBER_BACKEND": settings.transcriber_backend}
        if settings.transcriber_backend
        else None
    )
    transcript = backend.transcribe(audio_bytes)

    model = getattr(backend, "model_name", _MODEL_STUB)
    event = build_event(transcript, audio_hash, model)
    validated = contract.validate_transcript(event)
    if isinstance(validated, contract.Rejection):
        raise TranscribeRequestError(f"transcript rejected: {validated.reason}")

    # Same envelope shape as the provider-webhook function: org/source at
    # the top, the record itself nested under "event".
    payload: dict[str, Any] = {"org_id": org_id, "source": _SOURCE, "event": event}
    signed = callback.build_signed_request(payload, settings.webhook_shared_secret)
    response = post(settings.webhook_url, signed["headers"], signed["raw_body"])

    body = _read_json(response)
    return {
        "status_code": getattr(response, "status_code", 200),
        "body": body,
        "audio_hash": audio_hash,
        "raw_body_sent": signed["raw_body"],
    }


def _read_json(response: Any) -> Any:
    text = getattr(response, "text", None)
    if isinstance(text, str):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}
    return None
