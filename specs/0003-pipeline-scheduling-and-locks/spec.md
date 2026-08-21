# 0003 — Pipeline Scheduling and Locks

**Status:** proposed · **Lane:** W2-B · **Debt closed:** D-11, D-12, D-13, D-14, D-10

## Why

- No scheduler exists — every run is manual HTTP (D-11), and the comment at app/api/ingestion/run/route.ts:64 promises one (D-10).
- No lock protects the cursor, so overlapping runs double-advance it (D-12).
- Webhook runs are never reaped (D-13) and the corpus index only refreshes by hand (D-14).

## User stories

**US-01** — As an operator, I want ingest/quality/reindex on pg_cron, so the pipeline runs without a human.
**US-02** — As an operator, I want run locking, so two overlapping runs cannot advance the same cursor.
**US-03** — As an operator, I want webhook runs reaped like polling runs, so no run is stuck `running` forever.
**US-04** — As a user, I want a fresh corpus index, so search answers current data.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN pg_cron configured WHEN the schedule fires THEN ingest, quality and reindex each produce a run row with no human action (SQL: `select * from cron.job` shows the 3 jobs; e2e: `tests/scheduler.spec.ts`, D-11)
**AC-02** — GIVEN two overlapping runs for one org WHEN both try to start THEN exactly one acquires `pg_try_advisory_lock`; the second is refused (SQL: advisory-lock query; test: `tests/scheduler-lock.spec.ts`, D-12)
**AC-03** — GIVEN a `running` run for an org WHEN a second run for that org starts THEN the partial unique index rejects it (migration `20260821110000`; SQL: unique partial index on `pipeline_runs(org_id)` where status = 'running', D-12)
**AC-04** — GIVEN a webhook run WHEN it completes or fails THEN reap is called from the webhook path too, not only polling (test: `tests/webhook-reap.spec.ts`, D-13)
**AC-05** — GIVEN new invoices ingested WHEN the reindex schedule fires (or the trigger event) THEN chunks update and a freshness test asserts the index is not stale (test: `tests/index-freshness.spec.ts`, D-14)
**AC-06** — GIVEN the comment “Stage 4's cron” at app/api/ingestion/run/route.ts:64 WHEN the scheduler lands THEN the comment is gone or replaced by the real mechanism (grep: no `Stage 4's cron` in the repo, D-10)

## Invariants

- At most one `running` run per org.
- Cursor advances only under the advisory lock.
- Idempotency is preserved — the scheduler adds triggers, never changes the ingest contract.
- Reap runs on every completion path.

## Out of scope

- A distributed queue or exactly-once delivery (at-least-once + dedup stays).
- Changing ingestion itself (spec 0004).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W2-B).
