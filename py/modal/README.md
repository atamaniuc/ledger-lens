# ledgerlens-modal — Whisper transcription on Modal (spec 0009, D-42)

Audio in, timestamped transcript out, delivered into the *same* ingestion
pipeline as invoices: the transcript lands in `raw_events` (source
`transcription`, `run_id`, `correlation_id`) and becomes a `documents` row
(kind `transcript`) that the existing indexer chunks, embeds and searches.
Malformed transcripts quarantine with a reason exactly like any other source.
Nothing here is a side channel.

This is a self-contained uv project — its own `pyproject.toml` and lockfile;
it does not touch `py/pyproject.toml`.

## What a human must do to deploy it for real

1. **Migration**: apply `supabase/migrations/20260821150000_transcripts.sql`
   (adds `documents.raw_event_id`/`run_id`, kind `transcript`, and
   `public.ingest_transcript`, the atomic raw_events→documents/quarantine
   writer) — `supabase db push` in CI, or by hand.
2. **Edge Function**: deploy `supabase/functions/transcribe-webhook`
   (`supabase functions deploy transcribe-webhook`). It reads
   `WEBHOOK_SHARED_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (the last two are injected by the platform).
3. **Modal secret** (one command):
   ```
   modal secret create ledgerlens-transcribe-webhook \
     SUPABASE_URL=https://<project-ref>.supabase.co \
     WEBHOOK_SHARED_SECRET=<identical value to the Edge Function's>
   ```
   (If the Edge Function uses a different secret name than
   `WEBHOOK_SHARED_SECRET`, both must hold the same value.)
4. **Deploy** from this directory: `modal deploy modal_transcription.app`
   (or `modal deploy` with `[project] name`). Watch Modal's GPU quota
   console — the free monthly GPU credits are the whole budget.

## Run locally without a Modal account

The deterministic stub backend stands in for Whisper (same audio → same
transcript → same content hash, so idempotency behaves exactly as in
production):

```
uv sync --dev
MODAL_TRANSCRIBER_BACKEND=stub uv run python -m modal_transcription.cli transcribe call.wav --org-id <uuid> --webhook-url http://127.0.0.1:54321/functions/v1/transcribe-webhook
```

## Cost shape (stated in code too — config.py)

One on-demand GPU function, billed per second while a container runs,
containers scale to zero (`container_idle_timeout=60`), no volumes, no
schedules: an idle deployment costs $0. A 10-minute interview is tens of
seconds of T4 GPU time — well under a cent per call at on-demand rates (see
Modal's pricing page for current figures); the free monthly quota covers
thousands of calls. The only real spend is many large files, bounded by
`MODAL_MAX_AUDIO_BYTES`.

## Gates

```
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

The e2e spec `drafts/transcribe-idempotency.spec.ts` (Playwright, live
stack) is written for the parent lane to place at `tests/transcribe-idempotency.spec.ts`.
