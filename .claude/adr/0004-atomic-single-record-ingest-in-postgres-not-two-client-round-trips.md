# 0004: atomic single-record ingest in Postgres, not two client round-trips

Status: Accepted

## Context

ADR 0003 settled *where* ingestion runs. It did not settle how a single
record gets written, and the implementation that followed took the obvious
route: the Supabase client issues an `INSERT ... ON CONFLICT DO NOTHING
RETURNING id` against `raw_events`, and then — if a row came back — a
second statement inserting into `invoices` or `quarantine`. Both ingestion
paths (the polling route and the `provider-webhook` Edge Function) did it
that way, independently.

The review pass on that implementation showed the pattern is unsound, and
that the unsoundness is specifically hard to notice.

Idempotency was keyed on "does a `raw_events` row exist." If the process
dies between the two statements — a transient error, a serverless
invocation hitting its execution limit, a `date` value Postgres rejects
that Zod accepted — the raw event is committed with no `invoices` and no
`quarantine` row. Nothing is left to signal that. Worse, the retry that
should heal the gap is the thing that closes it permanently: the second
attempt conflicts on `raw_events`, is classified as an already-ingested
duplicate, and is skipped. On the webhook path, where at-least-once
redelivery is the documented contract, that redelivery returns HTTP 200
with `status: "duplicate"` and marks its run `succeeded`.

So the failure mode is a permanently orphaned payload, reported as
success, with `pipeline_runs` counters that look plausible. That directly
contradicts the PRD's counter-metric for this stage — *zero silent drops:
every raw record ends up in either `invoices` or `quarantine` with a
reason, never neither*.

## Decision

Both writes for one record happen inside a single Postgres function,
`public.ingest_raw_event`, called once per record via `supabase.rpc()`.
A function body is one transaction, so the `raw_events` insert and its
`invoices`/`quarantine` counterpart commit together or not at all — an
orphan cannot be created.

The function returns one of three outcomes: `written`, `quarantined`, or
`duplicate`.

Idempotency's predicate changes with it. A conflict on `raw_events` counts
as a duplicate only when that raw event *also* already has an `invoices`
or `quarantine` row. A conflict with neither is an orphan from an earlier
run, and the function completes it rather than skipping it — so orphans
created before this ADR heal on the next run that touches them, without a
backfill script.

Validation stays in TypeScript. `lib/ingestion/transform.ts` is shared
verbatim by both paths (ADR 0002), and the function receives an
already-decided outcome — the invoice fields, or a quarantine reason. The
Zod schema is not reimplemented in SQL; that would recreate the
two-implementations problem this stage exists to avoid, one layer down.

Both `ingest_raw_event` and its companion `reap_abandoned_runs` are
`SECURITY INVOKER` with `search_path` pinned to `''`, and `EXECUTE` is
revoked from `public`, `anon`, and `authenticated`. Callers are the
pipeline's own service-role client, which already bypasses RLS; a
definer-rights function would add an RLS-bypassing RPC surface for no
benefit.

## Consequences

- The "zero silent drops" counter-metric becomes true rather than
  asserted, and the `rows_read = rows_written + rows_quarantined +
  rows_deduplicated` identity holds exactly on every run — which makes it
  a checkable invariant instead of documentation.
- Per-record round-trips drop from two to one. Not why this was done, but
  it matters at 200 records per page against a remote Postgres.
- Business logic now spans two languages. Validation is in TypeScript,
  write semantics in `plpgsql`, and reading the full path means reading
  both. This is a real cost, accepted because the alternative is a
  correctness hole rather than a style preference.
- Migrations are now load-bearing for application behavior, not just
  schema. Changing the outcome contract means a migration plus matching
  changes in both callers, in step. The shared `IngestOutcome` type in
  `lib/ingestion/constants.ts` is the seam where that contract is written
  down.
- `supabase.rpc()` is untyped without generated Supabase types, so the
  return shape is a hand-written interface. Generating types would be
  better, but adds a large file that can silently drift from the schema
  with no CI to catch it. Since resolved: `lib/supabase/database.types.ts` is
  generated and gated by `task types-check`, so the drift risk is covered.
  Function return shapes are not part of the generated types, so
  `IngestOutcome` stays hand-written.
- The function is not itself unit-tested; it was verified by executing all
  five outcome paths (including a deliberately orphaned row) against the
  live project. Postgres functions in this project have no test harness
  yet, which is a gap worth closing before more logic moves into them.

## Alternatives considered

- **Keep two statements, change the idempotency predicate client-side.**
  On conflict, look up the existing `raw_events.id`, check for a
  downstream row, and re-run the transform if there isn't one. This
  narrows the window but doesn't close it — the check-then-write is still
  two round-trips, so the same interruption between them produces the same
  orphan, just less often. Rejected: a race condition made rarer is still
  a race condition, and the PRD's claim here is absolute.
- **A reconciliation sweep instead of atomicity.** Let orphans happen, and
  have each run start by querying `raw_events left join invoices left join
  quarantine where both null` and reprocessing what it finds. Rejected as
  the primary mechanism — it makes the invariant eventually-true rather
  than true, and its cost grows with table size. Worth having anyway as a
  detector, and the healing behavior built into `ingest_raw_event`'s
  conflict path covers most of what it would have caught.
- **Wrap both statements in an explicit client-side transaction.** The
  supabase-js client has no transaction API — it speaks to PostgREST,
  where each request is its own transaction. Not available without dropping
  to a direct Postgres connection, which means a second client, a second
  connection-pooling story, and a second set of credentials in both
  runtimes. Rejected as more moving parts than the function it would be
  replacing.
- **Move validation into `plpgsql` too, so the whole record is handled in
  one place.** Superficially tidier, and it would remove the
  two-languages consequence above. Rejected: PRD US-05's requirement is
  that both ingestion paths share *the same transform code*, and a SQL
  reimplementation of the Zod schema is a second implementation by
  definition — the exact divergence risk this stage is built to eliminate.

See also: `.omc/skills/adr/SKILL.md`.
