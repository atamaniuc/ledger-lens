"""Transcript contract (spec 0009): the producer-side mirror of the Deno
transform's accept/reject decisions, tested on both sides of every rule so a
drift between the two implementations fails here."""

from __future__ import annotations

from datetime import date

from modal_transcription.contract import (
    MAX_SEGMENTS,
    MAX_TRANSCRIPT_CHARS,
    Rejection,
    Transcript,
    validate_transcript,
)

TODAY = date(2026, 8, 20)


def _valid() -> dict:
    return {
        "audio_hash": "a" * 64,
        "recorded_at": "2026-08-19",
        "duration_seconds": 5.0,
        "model": "faster-whisper-base",
        "transcript": {
            "text": "Good morning. Thank you for coming in.",
            "language": "en",
            "segments": [
                {"start": 0.0, "end": 2.0, "text": "Good morning."},
                {"start": 2.0, "end": 5.0, "text": "Thank you for coming in."},
            ],
        },
    }


def test_accepts_a_valid_timestamped_transcript() -> None:
    result = validate_transcript(_valid(), today=TODAY)
    assert isinstance(result, Transcript)
    assert result.language == "en"
    assert result.recorded_at == date(2026, 8, 19)
    assert len(result.segments) == 2
    assert result.segments[0].start == 0.0
    assert result.segments[1].end == 5.0


def test_accepts_recording_made_today() -> None:
    payload = _valid()
    payload["recorded_at"] = "2026-08-20"
    assert isinstance(validate_transcript(payload, today=TODAY), Transcript)


def test_rejects_impossible_future_recorded_at() -> None:
    """AC-03's impossible date: a recording made tomorrow quarantines."""
    payload = _valid()
    payload["recorded_at"] = "2026-08-21"
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert result.reason.startswith("future_dated:")
    assert "2026-08-21" in result.reason
    assert "2026-08-20" in result.reason


def test_rejects_non_date_recorded_at() -> None:
    payload = _valid()
    payload["recorded_at"] = "yesterday"
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert result.reason == "schema_validation_failed: recorded_at must be YYYY-MM-DD"


def test_rejects_missing_or_empty_text() -> None:
    for bad in [None, "", "   "]:
        payload = _valid()
        payload["transcript"]["text"] = bad
        result = validate_transcript(payload, today=TODAY)
        assert isinstance(result, Rejection)
        assert "transcript.text must be a non-empty string" in result.reason


def test_rejects_text_over_the_character_cap() -> None:
    payload = _valid()
    payload["transcript"]["text"] = "x" * (MAX_TRANSCRIPT_CHARS + 1)
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert result.reason.startswith("transcript_too_long:")


def test_rejects_bad_language() -> None:
    payload = _valid()
    payload["transcript"]["language"] = "not-a-language"
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "transcript.language invalid" in result.reason


def test_rejects_segments_that_are_not_an_array() -> None:
    payload = _valid()
    payload["transcript"]["segments"] = "nope"
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "segments must be an array" in result.reason


def test_rejects_too_many_segments() -> None:
    payload = _valid()
    payload["transcript"]["segments"] = [
        {"start": float(i), "end": float(i + 1), "text": "t"} for i in range(MAX_SEGMENTS + 1)
    ]
    payload["duration_seconds"] = float(MAX_SEGMENTS + 1)
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert result.reason.startswith("too_many_segments:")


def test_rejects_negative_start() -> None:
    payload = _valid()
    payload["transcript"]["segments"][0]["start"] = -0.5
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "start is negative" in result.reason


def test_rejects_end_before_start() -> None:
    payload = _valid()
    payload["transcript"]["segments"][1] = {"start": 4.0, "end": 2.0, "text": "bad"}
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "end not after start" in result.reason


def test_rejects_overlapping_segments() -> None:
    payload = _valid()
    payload["transcript"]["segments"][1] = {"start": 1.0, "end": 3.0, "text": "overlap"}
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "overlaps previous segment" in result.reason


def test_rejects_segment_end_beyond_duration() -> None:
    payload = _valid()
    payload["transcript"]["segments"][1]["end"] = 500.0
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "end exceeds reported duration" in result.reason


def test_rejects_bad_audio_hash() -> None:
    payload = _valid()
    payload["audio_hash"] = "not-a-hash"
    result = validate_transcript(payload, today=TODAY)
    assert isinstance(result, Rejection)
    assert "audio_hash must be a 64-char sha256 hex" in result.reason


def test_rejects_non_positive_duration() -> None:
    for bad in [0, -1, None, "long"]:
        payload = _valid()
        payload["duration_seconds"] = bad
        result = validate_transcript(payload, today=TODAY)
        assert isinstance(result, Rejection)
        assert "duration_seconds" in result.reason


def test_rejects_missing_transcript_object() -> None:
    payload = _valid()
    del payload["transcript"]
    assert isinstance(validate_transcript(payload, today=TODAY), Rejection)
    assert isinstance(validate_transcript(None, today=TODAY), Rejection)


def test_tolerates_small_segment_overlap_rounding() -> None:
    """Whisper's own output can overlap by milliseconds; that is not malformed."""
    payload = _valid()
    payload["transcript"]["segments"][1] = {"start": 1.99, "end": 5.0, "text": "ok"}
    assert isinstance(validate_transcript(payload, today=TODAY), Transcript)
