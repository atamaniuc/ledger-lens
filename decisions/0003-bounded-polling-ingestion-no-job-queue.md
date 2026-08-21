# 0003: Bounded per-invocation polling ingestion, no job queue

Status: Accepted

## Context

Stage 2 needs a home for the polling job. The PRD requires cursor-based incremental pulls, retry with backoff plus a circuit breaker that opens after 5 consecutive failures, and idempotent writes. No infra exists yet (ADR 0002: `infra/` not until Stage 4), so whatever runs the job must work with zero deployed infrastructure and stay the shape Stage 4 deploys without a rewrite.

## Decision

The job is a Next.js API route (`POST /api/ingestion/run`). One invocation = one bounded pass: walk the provider's cursor-paginated `/invoices` endpoint page by page up to a fixed `MAX_PAGES_PER_RUN` ceiling, retry+backoff and circuit breaker per page fetch. It persists `cursor_to` on its `pipeline_runs` row before returning — whether it ran out of pages or hit the ceiling; the next invocation reads the last succeeded run's `cursor_to` as `cursor_from`.

A full backfill is repeated invocation (curl/bun script locally; Vercel Cron on the same route from Stage 4). The breaker lives only in the invocation's locals: 5 consecutive failures abort that run (`failed`, reason on `pipeline_runs.error`); the next call starts fresh — US-02 met without cross-invocation state.

## Consequences

- Invokable and testable as plain HTTP from day one — no worker, no second terminal.
- The page ceiling is a real constraint under Vercel Cron: a dataset larger than `MAX_PAGES_PER_RUN` pages needs multiple scheduled invocations. Intentional headroom against serverless execution-time limits; the 200-row fixture fits in a few pages.
- No backpressure against overlapping invocations today (single tenant, manual). **Amendment (2026-08-19):** still true — Stage 4 shipped without a cron; the dashboard triggers nothing. The exclusion is now attached to the first real deploy: whatever creates the schedule creates the exclusion in the same change (advisory lock on `org_id` or a `jobs`-table `SKIP LOCKED`). Shipping a cron without it reintroduces the cursor race — visible as duplicate `raw_events`, not an error.
- The breaker resets every invocation: a provider down longer than one run is marked `failed` repeatedly. Visible via `pipeline_runs.error`; a real deployment adds invocation-level backoff (cron interval or last-failed check).

## Alternatives considered

- **`jobs` table + `SKIP LOCKED` worker:** needs something to poll the table — the same "what runs this on a schedule" question one level removed — plus a stuck/duplicate-worker failure mode. Rejected for the polling path; revisit for fan-out into retryable sub-tasks.
- **Long-running standalone worker:** nothing to host it before Stage 4; duplicates cursor/backoff logic; two execution models (ADR 0002 rejected that).
- **No page ceiling:** simpler, but ties correctness to fixture size. The bounded loop plus cursor costs one constant and stays correct at any dataset size.
