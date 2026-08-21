"""Configuration for the Modal transcription path (spec 0009).

Every variable is read defensively: a missing secret fails with a message
that names it, and nothing here talks to the app's zod schema
(src/platform/config.ts) because this project runs outside the Next.js app —
its environment is a Modal Secret in production and the shell locally. The
keys this module reads are reported to the parent for the deployment doc:

    SUPABASE_URL                    the Supabase API URL the webhook posts to
    WEBHOOK_SHARED_SECRET           HMAC secret shared with the Edge Function
    MODAL_TRANSCRIBE_WEBHOOK_PATH   default /functions/v1/transcribe-webhook
    MODAL_TRANSCRIBER_BACKEND       stub | faster-whisper (default: auto)
    MODAL_WHISPER_MODEL             faster-whisper model size (default: base)
    MODAL_MAX_AUDIO_BYTES           upload cap (default 25 MiB)

Cost shape — read before deploying (the free-credits budget is the whole
point): the app is a single on-demand function, billed per second of GPU
while a container runs, and containers scale to zero. There is no reserved
GPU and nothing idles: Modal destroys a container after
`container_idle_timeout` (60s here) without work, so an idle deployment
costs $0. A T4 at on-demand rates (a few tens of cents per hour — check
Modal's pricing page for the current figure) transcribes a 10-minute
interview in tens of seconds of GPU time, i.e. well under a cent per call;
the free monthly GPU quota covers thousands of such calls. The only way to
spend real money is many large files, which the `max_audio_bytes` cap
bounds.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

# 10 MiB default: the audio travels base64-encoded (~13.3 MiB on the wire)
# and must fit the platform's HTTP request limit. Larger files belong in
# object storage (out of scope for spec 0009). Env-configurable (P1 T6).
DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024
DEFAULT_WEBHOOK_PATH = "/functions/v1/transcribe-webhook"
DEFAULT_TRANSCRIBE_MODEL = "base"


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    webhook_shared_secret: str
    webhook_path: str = DEFAULT_WEBHOOK_PATH
    max_audio_bytes: int = DEFAULT_MAX_AUDIO_BYTES
    transcriber_backend: str | None = None
    whisper_model: str = DEFAULT_TRANSCRIBE_MODEL
    webhook_url: str = ""


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    """Read settings from the environment (Modal Secret in production)."""
    env = os.environ if env is None else env
    supabase_url = env.get("SUPABASE_URL")
    if not supabase_url:
        raise RuntimeError("SUPABASE_URL is not set — the webhook has nowhere to call back to")
    secret = env.get("WEBHOOK_SHARED_SECRET")
    if not secret:
        raise RuntimeError(
            "WEBHOOK_SHARED_SECRET is not set — the transcribe-webhook Edge Function "
            "rejects every unsigned call"
        )
    try:
        max_bytes = int(env.get("MODAL_MAX_AUDIO_BYTES", str(DEFAULT_MAX_AUDIO_BYTES)))
    except ValueError as exc:
        raise RuntimeError(
            f"MODAL_MAX_AUDIO_BYTES must be an integer, got {env.get('MODAL_MAX_AUDIO_BYTES')!r}"
        ) from exc
    if max_bytes <= 0:
        raise RuntimeError(f"MODAL_MAX_AUDIO_BYTES must be positive, got {max_bytes}")

    webhook_path = env.get("MODAL_TRANSCRIBE_WEBHOOK_PATH", DEFAULT_WEBHOOK_PATH)
    return Settings(
        supabase_url=supabase_url,
        webhook_shared_secret=secret,
        webhook_path=webhook_path,
        max_audio_bytes=max_bytes,
        transcriber_backend=env.get("MODAL_TRANSCRIBER_BACKEND"),
        whisper_model=env.get("MODAL_WHISPER_MODEL", DEFAULT_TRANSCRIBE_MODEL),
        webhook_url=supabase_url.rstrip("/") + webhook_path,
    )
