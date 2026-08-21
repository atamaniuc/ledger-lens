"""Transcript contract for the Modal transcription path (spec 0009, D-42).

Producer-side mirror of the contract enforced by
`supabase/functions/transcribe-webhook/transform.ts` — the Edge Function is
the gate (it decides quarantine); this module exists so Modal never *sends*
something the gate would reject. Every constant and every reason string here
is kept in lockstep with that file; the pytest suite asserts both sides of
the decisions (accept + reject) so a drift between the two shows up as a
test failure.

The "impossible date" rule is D-15's, applied to a recording: `recorded_at`
may be today at the latest. A transcript that claims to have been recorded
in the future quarantines with `future_dated:` exactly like an
impossible-dated invoice would.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

# Lockstep constants — mirror supabase/functions/transcribe-webhook/transform.ts.
MAX_TRANSCRIPT_CHARS = 250_000
MAX_SEGMENTS = 10_000
# A recording longer than a day is not a recording; used as the segment
# timing sanity bound (also mirrored in the Deno transform).
MAX_DURATION_SECONDS = 24 * 60 * 60
# Whisper's own output has contiguous segments; a tiny overlap tolerance keeps
# a rounding artifact from being treated as malformed, nothing more.
SEGMENT_OVERLAP_TOLERANCE_SECONDS = 0.05
# The last segment's end may run a hair past the reported duration.
DURATION_TOLERANCE_SECONDS = 1.0

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_LANG_RE = re.compile(r"^[a-z]{2,3}(?:-[A-Z]{2})?$")


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class Transcript:
    """The validated, timestamped transcript Modal hands to the pipeline."""

    text: str
    language: str
    segments: tuple[TranscriptSegment, ...]
    recorded_at: date
    duration_seconds: float


@dataclass(frozen=True)
class Rejection:
    """The shape of a quarantine decision — `reason` is what lands in
    `quarantine.reason`, matching the invoice transform's contract."""

    reason: str
    details: dict[str, Any] | None = None


def _today_utc() -> date:
    return datetime.now(UTC).date()


def _segment_error(index: int, message: str) -> Rejection:
    return Rejection(
        reason=f"invalid_timing: segment {index} {message}", details={"segment": index}
    )


def validate_transcript(raw: Any, *, today: date | None = None) -> Transcript | Rejection:
    """Validate a transcript event (the payload a signed webhook carries).

    Mirrors the Deno transform's accept/reject decisions exactly, including
    the reason strings, so the pytest suite doubles as a parity check.
    """
    today = today or _today_utc()
    if not isinstance(raw, dict):
        return Rejection(reason="schema_validation_failed: transcript required")

    recorded_at_raw = raw.get("recorded_at")
    if not isinstance(recorded_at_raw, str) or not _DATE_RE.match(recorded_at_raw):
        return Rejection(reason="schema_validation_failed: recorded_at must be YYYY-MM-DD")
    try:
        recorded_at = date.fromisoformat(recorded_at_raw)
    except ValueError:
        return Rejection(reason="schema_validation_failed: recorded_at must be YYYY-MM-DD")
    if recorded_at > today:
        return Rejection(
            reason=(
                f"future_dated: recorded_at={recorded_at_raw} is after today ({today.isoformat()})"
            ),
            details={"recorded_at": recorded_at_raw, "today": today.isoformat()},
        )

    duration = raw.get("duration_seconds")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration <= 0:
        return Rejection(
            reason="schema_validation_failed: duration_seconds must be a positive number"
        )
    if duration > MAX_DURATION_SECONDS:
        return Rejection(
            reason=f"invalid_duration: duration_seconds={duration} exceeds {MAX_DURATION_SECONDS}"
        )

    audio_hash = raw.get("audio_hash")
    if not isinstance(audio_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", audio_hash):
        return Rejection(reason="schema_validation_failed: audio_hash must be a 64-char sha256 hex")

    transcript = raw.get("transcript")
    if not isinstance(transcript, dict):
        return Rejection(reason="schema_validation_failed: transcript required")

    text = transcript.get("text")
    if not isinstance(text, str) or text.strip() == "":
        return Rejection(
            reason="schema_validation_failed: transcript.text must be a non-empty string"
        )
    if len(text) > MAX_TRANSCRIPT_CHARS:
        return Rejection(
            reason=f"transcript_too_long: text length {len(text)} exceeds {MAX_TRANSCRIPT_CHARS}"
        )

    language = transcript.get("language")
    if not isinstance(language, str) or not _LANG_RE.match(language):
        return Rejection(reason="schema_validation_failed: transcript.language invalid")

    segments_raw = transcript.get("segments")
    if not isinstance(segments_raw, list):
        return Rejection(reason="schema_validation_failed: transcript.segments must be an array")
    if len(segments_raw) > MAX_SEGMENTS:
        return Rejection(reason=f"too_many_segments: {len(segments_raw)} exceeds {MAX_SEGMENTS}")

    segments: list[TranscriptSegment] = []
    prev_end = 0.0
    for i, seg in enumerate(segments_raw):
        if not isinstance(seg, dict):
            return _segment_error(i, "must be an object")
        start = seg.get("start")
        end = seg.get("end")
        seg_text = seg.get("text")
        if not isinstance(start, (int, float)) or isinstance(start, bool):
            return _segment_error(i, "start must be a number")
        if not isinstance(end, (int, float)) or isinstance(end, bool):
            return _segment_error(i, "end must be a number")
        if start < 0:
            return _segment_error(i, "start is negative")
        if end <= start:
            return _segment_error(i, "end not after start")
        if start < prev_end - SEGMENT_OVERLAP_TOLERANCE_SECONDS:
            return _segment_error(i, "overlaps previous segment")
        if end > duration + DURATION_TOLERANCE_SECONDS:
            return _segment_error(i, "end exceeds reported duration")
        if not isinstance(seg_text, str):
            return _segment_error(i, "text must be a string")
        segments.append(TranscriptSegment(start=float(start), end=float(end), text=seg_text))
        prev_end = end

    return Transcript(
        text=text,
        language=language,
        segments=tuple(segments),
        recorded_at=recorded_at,
        duration_seconds=float(duration),
    )
