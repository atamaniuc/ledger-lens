"""Content-keyed idempotency (spec 0009, AC-02)."""

from __future__ import annotations

import json
import re

from modal_transcription.idempotency import audio_id, payload_hash

AUDIO_ONE = b"RIFF....WAVEfake-audio-bytes-1"
AUDIO_TWO = b"RIFF....WAVEfake-audio-bytes-2"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def test_same_audio_produces_the_same_id() -> None:
    assert audio_id(AUDIO_ONE) == audio_id(AUDIO_ONE)


def test_different_audio_produces_different_ids() -> None:
    assert audio_id(AUDIO_ONE) != audio_id(AUDIO_TWO)


def test_id_is_sha256_hex_of_the_bytes() -> None:
    import hashlib

    assert audio_id(AUDIO_ONE) == hashlib.sha256(AUDIO_ONE).hexdigest()


def test_id_shape_matches_what_the_webhook_accepts() -> None:
    """The Deno function validates audio_hash as ^[0-9a-f]{64}$ and uses it as
    raw_events.external_id — the shape is load-bearing, not decorative."""
    assert HEX64.fullmatch(audio_id(AUDIO_ONE))
    assert HEX64.fullmatch(audio_id(AUDIO_TWO))


def test_payload_hash_is_deterministic() -> None:
    payload = {"transcript": {"text": "hi"}, "n": 1}
    assert payload_hash(payload) == payload_hash(payload)


def test_payload_hash_changes_with_content() -> None:
    assert payload_hash({"a": 1}) != payload_hash({"a": 2})


def test_payload_hash_matches_sha256_of_wire_bytes() -> None:
    import hashlib

    payload = {"transcript": {"text": "hi"}, "n": 1}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    assert payload_hash(payload) == hashlib.sha256(raw.encode("utf-8")).hexdigest()
