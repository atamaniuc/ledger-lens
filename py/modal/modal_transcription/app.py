"""Modal app: Whisper transcription on a serverless GPU (spec 0009, D-42).

Deploy with `modal deploy modal_transcription.app` from this directory. The
whole app is one on-demand function plus one web endpoint — no volumes, no
schedules, no always-on containers.

COST SHAPE (the free-credits budget is the whole point, so it is stated in
code, not only in prose): Modal bills per second of GPU while a container
runs, and containers scale to zero — `container_idle_timeout=60` destroys a
container after a minute without work, so an idle deployment costs $0. A T4
at on-demand rates (tens of cents per GPU-hour — see Modal's pricing page)
transcribes a 10-minute interview in tens of seconds of GPU time, i.e. well
under a cent per call; Modal's free monthly GPU quota covers thousands of
such calls. The only way to spend real money is many large files, bounded by
`MODAL_MAX_AUDIO_BYTES` (see config.py).

Runtime secrets come from one Modal Secret, created once by a human:

    modal secret create ledgerlens-transcribe-webhook \
        SUPABASE_URL=https://<project-ref>.supabase.co \
        WEBHOOK_SHARED_SECRET=<the same value the Edge Function verifies>

Local run without a Modal account: the CLI uses the deterministic stub
backend and never talks to Modal:

    python -m modal_transcription.cli transcribe call.wav --org-id <uuid>
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

from modal import App, Image, Secret, web_endpoint

from modal_transcription import service

app = App("ledgerlens-transcribe")

# The GPU image installs the real model; the client itself stays thin.
image = Image.debian_slim().pip_install("faster-whisper>=1.0,<2", "httpx>=0.27,<1")

WEBHOOK_SECRET = Secret.from_name("ledgerlens-transcribe-webhook")


@app.function(
    image=image,
    gpu="T4",
    timeout=900,
    container_idle_timeout=60,
    secrets=[WEBHOOK_SECRET],
)
def transcribe_and_deliver(org_id: str, audio_base64: str) -> dict[str, Any]:
    """Transcribe one audio document and deliver it to the pipeline.

    The audio arrives base64-encoded (JSON-safe); the `audio_hash` content
    key and the signed webhook make redelivery idempotent, so this function
    may be retried freely — at-least-once is the delivery contract.
    """
    audio_bytes = base64.b64decode(audio_base64, validate=True)
    return service.handle_transcribe_request(org_id, audio_bytes)


@app.function(
    image=image,
    timeout=900,
    container_idle_timeout=60,
    secrets=[WEBHOOK_SECRET],
)
@web_endpoint(method="POST", label="transcribe")
def transcribe(org_id: str, audio_base64: str) -> dict[str, Any]:
    """HTTP entry point: POST {"org_id": "<uuid>", "audio_base64": "<...>"}.

    Returns the webhook's outcome (succeeded / duplicate / quarantined) plus
    the audio_hash idempotency key, so a caller can see exactly what the
    pipeline did with the audio.
    """
    try:
        return transcribe_and_deliver.local(org_id, audio_base64)
    except (service.TranscribeRequestError, binascii.Error, ValueError) as exc:
        message = exc.message if isinstance(exc, service.TranscribeRequestError) else str(exc)
        return {"error": message, "status_code": 400}
