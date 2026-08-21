"""Structured JSON logging with a correlation_id on every line (AGENTS.md invariant)."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Any, TextIO


class JsonLogger:
    """Writes one JSON object per line; correlation_id is always present."""

    def __init__(self, correlation_id: str, stream: TextIO | None = None) -> None:
        self.correlation_id = correlation_id
        self._stream = stream if stream is not None else sys.stdout

    def log(self, event: str, **fields: Any) -> None:
        record: dict[str, Any] = {
            "correlation_id": self.correlation_id,
            "event": event,
            "ts": datetime.now(UTC).isoformat(),
        }
        record.update(fields)
        self._stream.write(json.dumps(record, default=str) + "\n")
        self._stream.flush()

    def __call__(self, event: str, **fields: Any) -> None:
        self.log(event, **fields)
