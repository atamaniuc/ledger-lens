"""Transcriber backends (spec 0009).

`Transcriber` is the seam that makes this whole project testable without a
Modal account: the deterministic `StubTranscriber` is the default outside
Modal, and `FasterWhisperTranscriber` (imported lazily, never at module
import time) is what runs on Modal's GPU. The Modal app itself is in
app.py; this module knows nothing about Modal.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from collections.abc import Mapping
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Protocol

from modal_transcription.contract import Transcript, TranscriptSegment

STUB_BACKEND = "stub"
WHISPER_BACKEND = "faster-whisper"


def _today_utc() -> date:
    return datetime.now(UTC).date()


class Transcriber(Protocol):
    """Backend contract. model_name is what lands in raw_events.payload, so
    an operator can tell which model produced a transcript."""

    @property
    def model_name(self) -> str: ...

    def transcribe(self, audio: bytes) -> Transcript: ...


class StubTranscriber:
    """Deterministic stand-in for Whisper: no account, no model, no network.

    The transcript is a pure function of the audio bytes, so idempotency
    holds exactly as it will in production — the same file transcribed twice
    yields the same text, the same timestamps, and therefore the same content
    hash and the same raw_events key.
    """

    model_name = "stub-whisper"

    def transcribe(self, audio: bytes) -> Transcript:
        digest = hashlib.sha256(audio).hexdigest()
        text = (
            f"Stub transcription of audio {digest[:12]}. This is a deterministic "
            "stand-in for the Whisper model; the real deployment runs "
            "faster-whisper on a Modal GPU."
        )
        return Transcript(
            text=text,
            language="en",
            segments=(TranscriptSegment(start=0.0, end=2.0, text=text),),
            recorded_at=_today_utc(),
            duration_seconds=2.0,
        )


class FasterWhisperTranscriber:
    """Real transcription via faster-whisper, imported lazily so the test
    environment never needs the (heavy) ctranslate2 stack.

    Segments are rendered as Whisper does: monotonic, non-overlapping, with
    start/end in seconds. The model size is env-configurable and defaults to
    `base` — fast enough for the demo budget, and the cost-shape note in
    app.py covers the economics of a bigger one.
    """

    def __init__(self, model_size: str = "base") -> None:
        self._model_size = model_size
        self._model = None

    @property
    def model_name(self) -> str:
        return f"faster-whisper-{self._model_size}"

    def transcribe(self, audio: bytes) -> Transcript:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - exercised by human installs only
            raise RuntimeError(
                "faster-whisper is not installed. Install the 'transcriber' extra "
                "(uv sync --extra transcriber) or run with MODAL_TRANSCRIBER_BACKEND=stub."
            ) from exc

        if self._model is None:
            self._model = WhisperModel(self._model_size, device="cpu", compute_type="int8")
        model: WhisperModel = self._model

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio)
            path = Path(tmp.name)
        try:
            info, generator = model.transcribe(str(path), word_timestamps=False)
            segments = [
                TranscriptSegment(
                    start=float(seg.start), end=float(seg.end), text=str(seg.text).strip()
                )
                for seg in generator
                if str(seg.text).strip()
            ]
            text = " ".join(seg.text for seg in segments)
            return Transcript(
                text=text,
                language=str(info.language),
                segments=tuple(segments),
                recorded_at=_today_utc(),
                duration_seconds=float(info.duration),
            )
        finally:
            path.unlink(missing_ok=True)


def make_transcriber(env: Mapping[str, str] | None = None) -> Transcriber:
    """Pick the backend. Inside a Modal container the real model runs; on any
    other machine the stub is the default (that is the "no Modal account"
    local mode). MODAL_TRANSCRIBER_BACKEND forces either side."""
    env = os.environ if env is None else env
    backend = env.get("MODAL_TRANSCRIBER_BACKEND")
    if backend is None:
        backend = WHISPER_BACKEND if "MODAL_CONTAINER_ID" in env else STUB_BACKEND
    if backend == STUB_BACKEND:
        return StubTranscriber()
    if backend == WHISPER_BACKEND:
        return FasterWhisperTranscriber(env.get("MODAL_WHISPER_MODEL", "base"))
    raise ValueError(f"unknown MODAL_TRANSCRIBER_BACKEND: {backend!r}")
