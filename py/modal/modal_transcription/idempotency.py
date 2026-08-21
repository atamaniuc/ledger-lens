"""Content-keyed idempotency for the transcription path (spec 0009, D-42).

The project's whole thesis is that the pipeline survives duplicate delivery.
Transcription makes that concrete by keying on *content*: `external_id` in
raw_events is the sha256 of the audio bytes, so the same audio submitted
twice — by Modal retrying its callback, or by a user re-uploading the file —
collides on raw_events' unique (org_id, source, external_id, event_version)
and produces exactly one transcript and one set of chunks.

`payload_hash` mirrors src/features/ingestion/hash.ts (sha-256 of the JSON
bytes, hex), which is what `raw_events.payload_hash` stores.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

HEX_RE = "^[0-9a-f]{64}$"


def audio_id(audio_bytes: bytes) -> str:
    """Content hash of the audio — the idempotency key for the whole path.

    Same bytes in, same id out; two different files collide only on a sha256
    collision. This is what Modal sends as `audio_hash` and what the webhook
    stores as raw_events.external_id.
    """
    return hashlib.sha256(audio_bytes).hexdigest()


def payload_hash(payload: dict[str, Any]) -> str:
    """Hash of the JSON payload exactly as it is serialized on the wire.

    Uses the same separators as callback.build_signed_request so the hash the
    database stores is over the same bytes the signature covers.
    """
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
