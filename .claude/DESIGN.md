# LedgerLens — Approved Architecture

Per `CLAUDE.md` Phase 1 step 3 and the `design` skill: each `## <stage>`
section here records the architecture `/superpowers:brainstorming`
converged on for that stage — components, data flow, error handling,
testing plan — with cross-links to the `.claude/PRD.md` entry it satisfies
and any `.claude/adr/` decisions that justify a non-obvious choice.

Project layout is approved (see "Project Layout" below, ADR 0002) — that
was the one open question blocking Stage 1 from starting. Stage-specific
design sections (Mock Provider's own component/data-flow breakdown, etc.)
get added here as each stage's brainstorming converges — per the `design`
skill's own rule, this file records decisions that have been made, not
exploration in progress.

Scaffold a stage's section once its design is approved:

```bash
scripts/harness/new-design-section.sh "<stage name>"
make design FEATURE="<stage name>"
```
## Project Layout

**PRD:** .claude/PRD.md#ledgerlens-overview
**ADR(s):** .claude/adr/0002-project-layout-single-next-js-app-no-monorepo.md

**Overview:**
LedgerLens is one Next.js app (TypeScript, Bun) at the repo root, scaffolded before Stage 1 rather than deferred to Stage 4. Supabase Edge Functions (Deno) live co-located under `supabase/functions/`, following the standard `supabase init` layout — not a separate package or workspace. No Nx/Turborepo/monorepo tooling: there is exactly one deployable JS/TS app plus a couple of small Edge Functions with no coordinated-build need between them.

**Components:**
- `app/` — Next.js routes, including `/api/mock-provider/*` (Stage 1) and later the dashboard (Stage 4). Depends on: Supabase client libs, Zod, TanStack Query.
- `supabase/migrations/` — SQL schema (from `docs/DATABASE_SCHEMA.md`). Depends on: nothing in this repo; consumed by `supabase db push`.
- `supabase/functions/provider-webhook/` — Deno Edge Function, the event-driven ingestion path (Stage 2). Depends on: the shared transform/validation module (see below), imported via relative path or `npm:` specifier — not Node-specific APIs.
- Shared transform/validation module (`lib/transform.ts` or similar, exact path TBD at Stage 2) — runtime-agnostic (Deno + Node compatible), imported by both the polling ingestion job and the webhook Edge Function so "same transform code" (PRD US-05) is literal, not just behavioral parity.
- `infra/` — Pulumi program (TypeScript), its own `package.json`, deployed independently of the app's own build.
- `evals/` — Python, independent toolchain.

**Data flow:**
No new data flow beyond what `docs/PROJECT_OVERVIEW.md`'s architecture diagram already shows — this section is about where the code that implements that flow physically lives, not the flow itself.

**Error handling:**
N/A at the layout level — deferred to each stage's own DESIGN.md section.

**Testing plan:**
Layout itself isn't independently tested; validated indirectly by later stages actually building on it without a mid-project restructure. If the shared transform module turns out not to import cleanly into Deno, that's a signal to fall back to duplication + a shared test fixture (see ADR 0002 Consequences) rather than reaching for monorepo tooling.

**Open questions / risks:**
- Exact path/name of the shared transform module — decided at Stage 2 implementation time, not here.
- If Deno import friction turns out worse than expected in practice, revisit the "same code" approach (duplication + shared fixture is the documented fallback, not a monorepo).

## Ingestion & Transform

**PRD:** `.claude/PRD.md` — "Ingestion & Transform" section (US-01..US-05).
**ADR(s):** [0003](adr/0003-bounded-per-invocation-polling-ingestion-no-job-queue.md) — bounded per-invocation polling, no job queue. [0002](adr/0002-project-layout-single-next-js-app-no-monorepo.md) — why the Deno function imports shared TypeScript by relative path.

**Overview:**

One polling ingestion path (Next.js API route) and one push path (Deno
webhook Edge Function). Both authenticate their caller, both call the same
`validateInvoice`, and both write through the same atomic Postgres function
— so idempotency and validation are proven once and reused, not
reimplemented twice, which is the actual requirement in US-05.

This section was updated after implementation and review (Definition of
Done item 5). The pre-implementation version had both paths issuing the
raw-event insert and its downstream insert as two separate statements; the
review pass showed that leaves unrecoverable orphans, so the write path
moved into Postgres. Nothing else about the shape changed.

**Components:**

- `lib/ingestion/transform.ts` — pure, no I/O. `validateInvoice(raw)` returns
  `{ok: true, invoice}` or `{ok: false, reason, details}` (Zod against the mock
  provider's `RawInvoice` shape). Shared verbatim: the Next.js route imports it
  normally, the Deno function by relative path (ADR 0002, with
  `supabase/functions/provider-webhook/deno.json` mapping the bare `zod`
  specifier to `npm:zod` for the Edge Runtime).
- `lib/ingestion/constants.ts` — `EVENT_VERSION`, `PIPELINE_VERSION`, and the
  `IngestOutcome` type. `EVENT_VERSION` is part of the idempotency key, so the
  two paths drifting on its value would create duplicate raw events for the
  same record — the one thing this stage exists to prevent. Hardcoding it in
  each path made that drift possible; a shared constant does not.
- `lib/ingestion/cursor.ts` — cursor and breaker arithmetic as pure functions:
  `nextCursorTo`, `parseCursor`, `parseRetryAfterMs`, `countersBalance`, plus
  the `MAX_PAGES_PER_RUN`/`CONSECUTIVE_FAILURE_LIMIT` constants. Extracted
  because the first implementation inlined all of it in the route handler,
  where it was untestable without a live database — and three of the review’s
  six defects lived in exactly that untested arithmetic.
- `lib/ingestion/backoff.ts` — `withRetry(fn, opts)`: exponential backoff +
  jitter, honors an explicit `Retry-After` (capped separately from the computed
  backoff ceiling, since the provider's number can legitimately exceed it), and
  requires that value to be *finite* — `??` alone lets `NaN` through, and
  `setTimeout(cb, NaN)` fires at 1ms, turning a malformed header into a retry
  storm. The breaker decision stays in the caller, not here.
- `lib/ingestion/hash.ts` — `hashPayload` over `crypto.subtle`, a global in
  both Node and Deno, so it needs no runtime-specific import.
- `public.ingest_raw_event` (Postgres) — one atomic call per record: the
  `raw_events` insert plus its `invoices` or `quarantine` counterpart in a
  single transaction. Returns `written` / `quarantined` / `duplicate`. See
  `docs/DATABASE_SCHEMA.md`’s "Write path" section.
- `public.reap_abandoned_runs` (Postgres) — closes out runs stuck at
  `running` because their invocation was killed. Called at the start of each
  run; no scheduler to deploy (ADR 0003).
- `app/api/ingestion/run/route.ts` — `POST`, shared-secret authenticated.
  Reaps stale runs, resolves the resume cursor, opens a `pipeline_runs` row,
  then loops pages up to `MAX_PAGES_PER_RUN` within a wall-clock budget,
  calling `ingest_raw_event` per record. Closes the run row on every exit
  path, including breaker abort and budget exhaustion.
- `supabase/functions/provider-webhook/index.ts` — Deno Edge Function.
  Shared-secret auth, full body validation *before* any write, one
  `pipeline_runs` row with `kind='webhook'`, then the same
  `ingest_raw_event` call. One event per request, no pagination, no cursor.
- `supabase/functions/provider-webhook/simulate.sh` — asserts four cases
  (accepted / deduplicated / quarantined / rejected) and exits non-zero on
  mismatch. It is a gate, not a demo — see the testing plan below.

**Data flow:**

```
mock-provider /invoices --poll--> ingestion route --+
                                                    |
provider (push, simulated) --webhook--> Edge Fn ----+--> ingest_raw_event (one transaction)
                                                            |
                                            raw_events + (invoices | quarantine)
```

Every write carries the owning `pipeline_runs.run_id` and the source
`raw_events.id`, so any `invoices`/`quarantine` row traces back to the exact
raw payload and run that produced it (the lineage drill-down Stage 4 needs).
Every run also carries a `correlation_id` on both its log lines and its
`pipeline_runs` row.

**Error handling:**

- Page fetch fails: `withRetry` backs off; 5 consecutive page-level failures
  trip the breaker, the run ends `failed` with `error` populated, and
  `cursor_to` stays at the last page that was fully written — a failed page is
  retried at the same cursor, never skipped.
- Record fails validation: quarantined with a reason, page continues (US-04).
- Record fails to *write* (a date Zod accepts but Postgres rejects, an
  over-length field, a transient error): also quarantined, with
  `raw_event_id: null` because the atomic call rolled back. The page still
  continues; 5 consecutive record failures abort the run. Previously any such
  error killed the whole run, which contradicted US-04.
- Duplicate delivery, either path: `ON CONFLICT DO NOTHING` inside
  `ingest_raw_event` makes it a no-op — but only when the raw event already
  has a downstream row. Otherwise it is an orphan and gets completed.
- Wall-clock budget exceeded: run ends `succeeded` with its cursor persisted,
  so the next invocation continues. Bounded work, not a failure (ADR 0003).
- Webhook auth failure or malformed body: `401`/`400`, nothing written, no
  `pipeline_runs` row — nothing happened, nothing to record.
- Unauthenticated polling trigger: `401` before any DB access.

**Testing plan:**

- Unit (`bun test`, 21 tests): cursor arithmetic including the drained-dataset
  case that shipped broken; `Retry-After` parsing including the HTTP-date form;
  backoff clamping and the `NaN` guard; the counter-balance invariant;
  `validateInvoice` accepting schema drift and rejecting null customers.
- Postgres-level, verified against the live project: new event written; same
  event re-ingested returns `duplicate`; **a second tenant's identical
  `external_id` is written, not discarded**; invalid event quarantined; an
  orphaned raw event completed rather than skipped; zero orphans left behind.
  This is the evidence behind US-03’s North Star metric.
- `simulate.sh` for the webhook path, asserting outcomes.
- Not covered: the route handler end-to-end (needs
  `SUPABASE_SERVICE_ROLE_KEY`, absent in the build environment) and
  `deno check` (Deno not installed). `make check` runs everything that is
  available and says out loud what it skipped, rather than reporting a clean
  pass over a gap.

**Open questions / risks:**

- No generated Supabase types, so `supabase.rpc()` returns `{}` and the
  outcome shape is a hand-written interface (`IngestOutcome`). Generating them
  would be genuinely better typed, but adds a large file that can silently
  drift from the schema with no CI to catch it. Revisit when CI exists.
- No cross-invocation lock. Two overlapping runs for one `org_id` would both
  advance from the same cursor. Harmless today (single tenant, manual
  trigger); needs an advisory lock before Stage 4’s cron can fire alongside a
  manual trigger.
- The mock provider still cannot push, so the webhook is proven by
  `simulate.sh` rather than driven end-to-end. Extending Stage 1 to push would
  be scope drift into a finished stage.
- The `expiredToken` chaos flag is now survivable rather than fatal: the route
  rotates its Bearer token on a 401. The flag is still exercised (the 401 does
  happen and is logged) but no longer fails a run — a deliberate choice, since
  a real client refreshes its token. Noted because `CLAUDE.md` forbids
  softening mock-provider failure modes to make the pipeline pass, and this is
  the closest call in this stage.

## Data Quality & Reconciliation

**PRD:** `.claude/PRD.md` — "Data Quality & Reconciliation" section (US-01..US-05).
**ADR(s):** [0005](adr/0005-data-quality-checks-in-one-postgres-function-reconciliation-accounts-for-quarantined-value.md) — one Postgres function for all four checks, and why reconciliation counts quarantined value.

**Overview:**

Four checks — freshness, volume, uniqueness, reconciliation — run as one
Postgres function and write one `data_quality_results` row each, all inside a
single transaction, keyed to the `pipeline_runs.run_id` they describe. The
caller fetches the provider's independent `/summary` first and passes its
numbers in; the function performs no I/O.

The check worth arguing about is reconciliation. Comparing the provider's
total against `sum(invoices.amount_cents)` reports an 8.54% shortfall on a
pipeline behaving exactly as designed, because the twenty records the
provider deliberately corrupts are correctly quarantined rather than written.
Reconciliation therefore compares against *accounted* value — invoiced plus
the amounts recoverable from quarantined records' original payloads — which
lands on exactly zero and makes any nonzero result a real signal. ADR 0005
has the numbers and the rejected alternatives.

**Components:**

- `public.run_data_quality_checks(p_org_id, p_run_id, p_provider_total_cents,
  p_provider_invoice_count)` (Postgres) — computes all four checks and inserts
  four `data_quality_results` rows in one transaction. `SECURITY INVOKER`,
  `set search_path = ''`, `EXECUTE` granted to `service_role` only.
- `lib/data-quality/constants.ts` — check names, result types, and
  `worstStatus` (a run's verdict is the worst of its checks; one failure is
  not averaged away by three passes). Deliberately **no thresholds**: the
  design originally put the status arithmetic here as pure functions, which
  would have meant two sources of truth for the same numbers with nothing
  keeping them in sync. The numbers live where they are applied — in the
  SQL function — and their boundary behaviour is asserted against the live
  function in `tests/stage3-data-quality.spec.ts`, including both edges of
  every band.
- `lib/data-quality/run-checks.ts` — `fetchProviderSummary` and `runChecks`,
  shared by the standalone route and the end of an ingestion run so the two
  entry points cannot drift.
- `app/api/data-quality/run/route.ts` — `POST`, shared-secret authenticated
  the same way the ingestion trigger is. Fetches `/summary`, calls the
  function, returns the four results.
- The ingestion route calls the same endpoint's logic at the end of a
  successful run, so US-05's "every run" holds without a scheduler.

**Data flow:**

```
mock-provider /summary --+
                         |
pipeline_runs.run_id ----+--> run_data_quality_checks (one transaction)
invoices / quarantine ---+              |
raw_events --------------+     4 x data_quality_results
```

**Thresholds, and why these numbers:**

| Check | pass | warn | fail |
|---|---|---|---|
| freshness | `now() - max(ingested_at) < 2h` | 2h–24h | > 24h, or no data at all |
| volume | within ±50% of the trailing 7-day mean `rows_read` | ±50%–±80% | beyond ±80% |
| uniqueness | zero duplicate `(org_id, external_id)` | — | any duplicate |
| reconciliation | drift exactly 0, no unaccounted rows | \|drift\| ≤ 0.5% | otherwise, or any unaccounted row |

Volume measures `rows_read`, not `rows_written`, and this was a correction
made during implementation. The check asks whether an unexpectedly small or
large batch arrived from upstream. A run that reads its usual 207 records
and deduplicates every one of them is a healthy idempotent re-run — but it
writes zero, so a `rows_written` baseline scored it at −100% and failed it.
That is the false positive the PRD's counter-metric forbids, and it fired
on the most ordinary thing this pipeline does.

Two further abstentions, both for the same reason. Fewer than three prior
succeeded runs reports `pass` with `details.reason = "insufficient_history"`
rather than warning about a baseline that does not exist yet; a fresh
database is healthy. And a check invocation with no `run_id` at all reports
`pass` with `reason = "no_run_context"` — without a run there is no batch to
size, and treating the absent run as a zero-row batch failed volume on every
ad-hoc invocation.

**Error handling:**

- Provider `/summary` unreachable: the route returns 502 and writes nothing.
  Three checks would have succeeded, but a `data_quality_results` set missing
  its reconciliation row is worse than none — it reads as "reconciliation was
  not configured" rather than "reconciliation could not run".
- Called with a `run_id` that does not belong to `org_id`: the function raises
  rather than silently scoping to the wrong tenant.
- Called twice for the same `run_id`: rows accumulate. Results are a log, not
  a current-state table; the dashboard reads the newest per `(run_id,
  check_name)`.

**Testing plan:**

- Unit (`bun test`): threshold arithmetic including both boundaries of every
  band, the sign of drift, and the insufficient-history case.
- Postgres-level against the live local database: all four checks on a healthy
  run (reconciliation must be exactly 0); a forced stale `ingested_at`; a
  forced volume outlier; a quarantine row with a null `raw_event_id` driving
  reconciliation to `fail`.
- `tests/stage3-data-quality.spec.ts` end-to-end, and a Postman folder.
- RLS: a non-member reads zero `data_quality_results` rows.

**Open questions / risks:**

- Reconciliation depends on `raw_events.payload` keeping a readable `amount`.
  An upstream rename would make quarantined value unrecoverable and turn the
  check red — arguably correct, but the failure would point here rather than
  at the schema change.
- The volume baseline is per `org_id` across succeeded runs, so a run that
  legitimately reads nothing (drained cursor, nothing new upstream) still
  drags the mean down. Less acute now that the measure is `rows_read`
  rather than `rows_written`, but not gone. Worth watching once Stage 4's
  cron fires on a schedule rather than on demand.
- `uniqueness` cannot fail while `invoices` carries its
  `unique (org_id, external_id)` constraint. Kept deliberately (ADR 0005) so
  that a migration dropping the constraint does not silently take its
  verification with it, and its `details` carry a non-tautological
  observation — semantic duplicates under different `external_id`s — that is
  reported but not enforced.


