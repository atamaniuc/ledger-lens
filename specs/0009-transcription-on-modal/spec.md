# 0009 — Transcription on Modal

**Status:** partly shipped (5 of 7 tasks) · **Lane:** W3-H · **Debt closed:** D-42

## Why

- “Modal/GPU/transcription” from the JD is a name-drop until audio actually flows through the pipeline (D-42).

## User stories

**US-01** — As an interviewer, I want a real GPU workload, so Modal is a demonstration, not a name-drop.
**US-02** — As an operator, I want audio documents through the same transform/quarantine as invoices, so transcription is a first-class source, not a side channel.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN an audio document WHEN it is submitted to the Modal Whisper service THEN it produces a timestamped transcript ingested into `raw_events` and the same transform/quarantine path as invoices (test: `py/modal` pytest + e2e via signed webhook, D-42)
**AC-02** — GIVEN the same audio file twice WHEN it is transcribed THEN `raw_events` gains no duplicate rows — idempotency holds (test: `tests/transcribe-idempotency.spec.ts`, D-42)
**AC-03** — GIVEN a transcript with malformed content or an impossible date WHEN it is transformed THEN it quarantines with a reason like any other source (test, D-42)
**AC-04** — GIVEN the transcribe webhook WHEN it is called THEN it requires the signed-webhook auth from spec 0004 (HMAC + timestamp + nonce, replay test)
**AC-05** — GIVEN the repo WHEN CI runs THEN the python job covers `py/modal` (D-42 closure alongside specs 0005/0008)

## Invariants

- Transcription reuses the ingestion transform; no parallel reimplementation.
- Idempotency is at-least-once + dedup, same as polling.
- The webhook call is authenticated like `provider-webhook`.

## Out of scope

- Live streaming transcription.
- Speaker diarization or multilingual models.

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W3-H).
