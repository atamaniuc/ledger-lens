"""LedgerLens Modal transcription (spec 0009, D-42).

Audio in, timestamped transcript out, delivered into the same ingestion
pipeline as invoices via a signed webhook. See README.md in this directory.
"""

from modal_transcription.contract import (
    MAX_SEGMENTS,
    MAX_TRANSCRIPT_CHARS,
    Rejection,
    Transcript,
    TranscriptSegment,
    validate_transcript,
)
from modal_transcription.idempotency import audio_id, payload_hash
from modal_transcription.transcriber import (
    FasterWhisperTranscriber,
    StubTranscriber,
    make_transcriber,
)

__all__ = [
    "MAX_SEGMENTS",
    "MAX_TRANSCRIPT_CHARS",
    "Rejection",
    "Transcript",
    "TranscriptSegment",
    "validate_transcript",
    "audio_id",
    "payload_hash",
    "FasterWhisperTranscriber",
    "StubTranscriber",
    "make_transcriber",
]

__version__ = "0.1.0"
