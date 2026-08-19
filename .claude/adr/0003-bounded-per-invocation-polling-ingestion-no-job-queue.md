# 0003: bounded per-invocation polling ingestion no job queue

Status: Accepted

## Context

Stage 2 (Ingestion & Transform) needs a place for the polling ingestion
job to run. The PRD (`.claude/PRD.md`, "Ingestion & Transform") requires:
cursor-based incremental pulls (US-01), retry with backoff + a circuit
breaker that opens after 5 consecutive failures (US-02), and idempotent
writes (US-03). No infra (`infra/`, Pulumi) exists yet — per ADR 0002 and
`docs/PROJECT_OVERVIEW.md`'s roadmap, `infra/` isn't built until Stage 4.
Whatever runs the ingestion job today has to work with zero deployed
infrastructure and still be the shape Stage 4 deploys without a rewrite.

## Decision

The polling ingestion job is a Next.js API route
(`app/api/ingestion/run/route.ts`, `POST`), same pattern as the Mock
Provider's own routes (ADR 0002: no separate service, one Next.js app).
One invocation = one bounded pass: it walks the mock provider's
cursor-paginated `/invoices` endpoint page by page, up to a fixed
`MAX_PAGES_PER_RUN` ceiling, applying retry+backoff and the circuit
breaker per page fetch. It persists `cursor_to` on the `pipeline_runs`
row it owns before returning — regardless of whether it stopped because
it ran out of pages or hit the page ceiling. The next invocation reads
the last succeeded run's `cursor_to` as its `cursor_from` and continues.

This makes a full backfill "call the endpoint until a run reports no more
pages," which is just repeated invocation — locally via `curl`/a bun
script, and from Stage 4 onward via Vercel Cron hitting the same route on
a schedule. No new job-runner concept, no separate deploy target.

The circuit breaker's state lives only in the loop's local variables for
the duration of one invocation — 5 consecutive page-fetch failures abort
that run (status `failed`, reason on `pipeline_runs.error`, cursor left
at the last successfully processed page). It does not persist across
invocations; the next call starts a fresh breaker. This matches the
requirement in US-02 (breaker opens within a run) without inventing
cross-invocation state that Stage 2 doesn't ask for.

## Consequences

- Ingestion is invokable and testable as a plain HTTP call from day one —
  no worker process, no queue, nothing to run in a second terminal to
  exercise Stage 2 locally or in CI.
- A page ceiling per invocation is a real constraint once Vercel Cron is
  the caller (Stage 4): a dataset larger than `MAX_PAGES_PER_RUN` pages
  needs multiple scheduled invocations to fully catch up, not one. This
  is intentional headroom against serverless execution-time limits, not
  an oversight — the mock provider's 200-row fixture fits in a handful of
  pages, so it isn't hit at this project's scale.
- No backpressure/coordination is needed against overlapping invocations
  today (single-tenant, manually triggered, low volume). This will need
  revisiting — an advisory lock or `jobs`-table-backed exclusion, most
  likely — before two overlapping invocations for the same `org_id`
  become a real possibility (e.g., Stage 4's cron firing on top of a
  manual trigger).
- Circuit breaker state resetting every invocation means a provider that
  is down for longer than one run's page loop just gets marked `failed`
  repeatedly across many small runs, rather than backing off at the
  invocation level too. Acceptable for now — `pipeline_runs.error` makes
  every failure visible either way — but a real deployment would want an
  invocation-level backoff on top of this (e.g., cron interval itself, or
  a check against the most recent `failed` run's `finished_at`).

## Alternatives considered

- **`jobs` table + `SKIP LOCKED` worker.** The schema already has a
  `jobs` table (`docs/DATABASE_SCHEMA.md`) earmarked for background work
  paired with the webhook path. Rejected for the *polling* path
  specifically: it requires something to actually poll the `jobs` table
  (a long-running worker or another scheduled invocation calling back
  into itself), which is the same "what runs this on a schedule"
  question one level removed, plus a new failure mode (stuck/duplicate
  workers) for no benefit at this stage's volume. Revisit if ingestion
  ever needs to fan out into independently-retryable sub-tasks.
- **Long-running standalone worker (Node script, always-on process).**
  Rejected: nothing to host it on before Stage 4, and it duplicates the
  cursor/backoff logic a scheduled HTTP call gets for free. Would also
  mean two different execution models for local dev vs. production,
  which ADR 0002 specifically tried to avoid.
- **One invocation processes the entire remaining dataset, no page
  ceiling.** Simpler code, but ties correctness to "the mock provider's
  fixture happens to be small" — the first real acceptance criterion a
  larger dataset would break. The bounded-loop-plus-cursor shape costs
  one `MAX_PAGES_PER_RUN` constant and stays correct at any dataset size.

See also: `.omc/skills/adr/SKILL.md`.

---

## Amendment — 2026-08-19 (Stage 4)

Stage 4 shipped without a cron, so the "Stage 4's cron firing on top of a
manual trigger" case named above has not arrived and the advisory lock is
still not needed. That is a deferral with a date on it rather than a problem
solved.

The dashboard triggers nothing. It reads, and it listens to Realtime for
changes other things make; ingestion is still started by an authenticated
`POST /api/ingestion/run`, one invocation at a time, by a person. Two
overlapping runs for one `org_id` remain impossible in practice for the same
reason they were when this ADR was written.

**The precondition is now attached to a specific piece of work: the first real
deploy**, when `infra/` and the Pulumi program appear and a schedule becomes
something that can exist. Whatever creates that schedule creates the exclusion
in the same change — an advisory lock keyed on `org_id` taken by
`/api/ingestion/run`, or a `jobs`-table row with `SKIP LOCKED`, decided then
against how the scheduler actually invokes the route. Shipping a cron without
it would reintroduce exactly the cursor race this ADR describes, and it would
show up as duplicate `raw_events` rather than as an error.

Recorded here rather than in a backlog note because this ADR is where someone
adding the schedule will look.
