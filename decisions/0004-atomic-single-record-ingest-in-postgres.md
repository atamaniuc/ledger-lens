# 0004: Atomic single-record ingest in Postgres, not two client round-trips

Status: Accepted

## Context

ADR 0003 settled where ingestion runs, not how a record is written. The first implementation issued `INSERT ... ON CONFLICT DO NOTHING RETURNING id` into `raw_events`, then a second statement into `invoices`/`quarantine` — in both paths (polling route and `provider-webhook`). Review found the pattern unsound: idempotency was keyed on "does a `raw_events` row exist".

Death between the two statements (transient error, serverless limit, a date Postgres rejects that Zod accepted) commits the raw event with no downstream row, and the retry that should heal it closes it permanently: the second attempt conflicts on `raw_events`, is classified duplicate, and is skipped. On the webhook's at-least-once contract, redelivery returns HTTP 200 `duplicate` and marks its run `succeeded`. Failure mode: a permanently orphaned payload reported as success — contradicting the PRD's *zero silent drops* counter-metric.

## Decision

Both writes for one record happen inside one Postgres function, `public.ingest_raw_event`, called via `supabase.rpc()`. A function body is one transaction: the `raw_events` insert and its `invoices`/`quarantine` counterpart commit together or not at all.

It returns `written` | `quarantined` | `duplicate`. A conflict on `raw_events` counts as duplicate only when that raw event *also* has a downstream row; a conflict with neither is an orphan from an earlier run, and the function completes it — orphans heal on the next run that touches them, no backfill script.

Validation stays in TypeScript: `lib/ingestion/transform.ts` is shared verbatim by both paths (ADR 0002); the function receives an already-decided outcome. Both `ingest_raw_event` and `reap_abandoned_runs` are `SECURITY INVOKER`, `search_path` pinned to `''`, `EXECUTE` revoked from `public`/`anon`/`authenticated`; callers are the pipeline's service-role client — a definer-rights function would add an RLS-bypassing RPC surface for no benefit.

## Consequences

- Zero-silent-drops becomes true rather than asserted: `rows_read = written + quarantined + deduplicated` holds exactly on every run — a checkable invariant.
- Per-record round-trips drop 2 → 1 (matters at 200 records/page against remote Postgres).
- Logic spans two languages (TS validation, plpgsql writes); `IngestOutcome` in `lib/ingestion/constants.ts` is the contract seam; migrations become load-bearing for behavior.
- Since resolved: `lib/supabase/database.types.ts` is generated and gated by `task types-check`; function return shapes are not in generated types, so `IngestOutcome` stays hand-written. Functions still lack a unit-test harness (verified live on all five outcome paths) — a gap worth closing before more logic moves into plpgsql.

## Alternatives considered

- **Keep two statements, fix the predicate client-side:** narrows the window, does not close it — check-then-write is still two round-trips. A race made rarer is still a race; the PRD claim is absolute.
- **Reconciliation sweep instead of atomicity:** makes the invariant eventually-true; cost grows with table size. Worth keeping as a detector; the conflict-path healing covers most of it.
- **Explicit client-side transaction:** supabase-js has none — PostgREST treats each request as its own transaction; a direct connection means a second client, pooling story, and credentials in both runtimes.
- **Move validation into plpgsql too:** a SQL reimplementation of the Zod schema is a second implementation by definition — the divergence risk this stage exists to eliminate (PRD US-05: both paths share the same transform code).
