"""Local CLI — the "no Modal account" way to run the pipeline.

    python -m modal_transcription.cli transcribe call.wav --org-id <uuid>

Uses the deterministic stub backend by default (see transcriber.py), which
makes the run reproducible and the idempotency key observable: the same file
always produces the same audio_hash. Point MODAL_TRANSCRIBER_BACKEND at
faster-whisper to run the real model on your CPU.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

from modal_transcription import service
from modal_transcription.config import Settings, settings_from_env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ledgerlens-modal", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    transcribe = sub.add_parser("transcribe", help="transcribe an audio file and deliver it")
    transcribe.add_argument("audio", type=Path, help="path to the audio file (wav/mp3/ogg)")
    transcribe.add_argument(
        "--org-id", required=True, help="the org the transcript belongs to (uuid)"
    )
    transcribe.add_argument(
        "--webhook-url", help="override the webhook URL (default: SUPABASE_URL + path)"
    )
    args = parser.parse_args(argv)

    try:
        settings = settings_from_env()
    except RuntimeError:
        # Zero-env local demo: the CLI needs no SUPABASE_URL or secret when
        # the webhook URL is given explicitly (the stack rejects the call if
        # the secret is missing — which is itself the auth demo).
        if not args.webhook_url:
            raise
        settings = Settings(supabase_url="", webhook_shared_secret="")
    if args.webhook_url:
        settings = replace(settings, webhook_url=args.webhook_url)

    audio = Path(args.audio).read_bytes()
    try:
        result = service.handle_transcribe_request(args.org_id, audio, settings=settings)
    except service.TranscribeRequestError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0 if result["status_code"] < 400 else 2


if __name__ == "__main__":
    raise SystemExit(main())
