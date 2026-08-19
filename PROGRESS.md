# LedgerLens — Progress

The single source of truth for what is built and what is next. `README.md` and
`docs/PROJECT_OVERVIEW.md` link here rather than restating it.

## Stages

| Stage | State | What it produced |
|---|---|---|
| 0 — PRD | done | 8 entries in [`.claude/PRD.md`](.claude/PRD.md) |
| 1 — Mock Provider | done | `/invoices` + `/summary`, 7 chaos flags, all runtime-verified |
| 2 — Ingestion & Transform | done | Polling route + webhook Edge Function, atomic ingest in Postgres (ADR [0003](.claude/adr/0003-bounded-per-invocation-polling-ingestion-no-job-queue.md), [0004](.claude/adr/0004-atomic-single-record-ingest-in-postgres-not-two-client-round-trips.md)) |
| 3 — Data Quality & Reconciliation | done | Four checks in one Postgres function per `run_id` (ADR [0005](.claude/adr/0005-data-quality-checks-in-one-postgres-function-reconciliation-accounts-for-quarantined-value.md)) |
| — Local dev loop | done | Containerised toolchain, `task` command surface, generated types (ADR [0006](.claude/adr/0006-the-app-is-containerised-the-supabase-stack-is-not-duplicated.md)) |
| **4 — Dashboard** | **in progress** | Authenticated page over Stages 1–3 (ADR [0007](.claude/adr/0007-the-dashboard-reads-through-the-users-own-jwt-rls-is-the-only-authorization.md)); tasks in [`tasks.md`](tasks.md) |
| 5 — RAG & Agent | not started | Depends on 4 |
| 6 — Evals + CI gate | not started | Depends on 5 |
| 7 — Stretch | not started | Optional, independent |

## What runs today

The stack runs end-to-end on one machine: local Supabase in Docker seeded with
two tenants and two auth users, the app in a `dev` container against the same
Linux/Bun environment that ships, an IDE-attachable debugger on `localhost:9230`,
and 38 Playwright tests asserting each stage over HTTP from an empty database.
`task` with no arguments prints every command. Setup and curl recipes are in
[`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md).

RLS is asserted through two different doors — impersonating the `authenticated`
role in Postgres, and signing in through GoTrue for real. The second is not
redundant: it caught the seed writing NULL into `auth.users.confirmation_token`,
which GoTrue scans into a Go `string`, so every real sign-in failed with a 500
while every impersonated check kept passing.

## Baselines

- **Reconciliation drift: exactly 0.** The check compares the provider's
  independent total (52,417,661) against *accounted* value — invoiced
  (47,942,632) plus quarantined-but-recoverable (4,475,029). Comparing against
  written invoices alone reports −8.54% on a healthy pipeline, which is why that
  framing was rejected (ADR 0005). Before/after pair in
  [`docs/RECONCILIATION_BASELINE.md`](docs/RECONCILIATION_BASELINE.md).
- **`get_advisors`, 2026-08-18, hosted project:** security clean, performance 10
  INFO `unused_index` across `data_quality_results`, `memberships`,
  `pipeline_runs`, `raw_events`, `invoices`, `quarantine` — expected on tables the
  dashboard has not queried yet. Later stages diff against this, not against zero.

## Known limitations

Carried forward deliberately, not dropped:

- **No CI.** `task check` and `task e2e` are habits, not gates. Nothing enforces
  them on a push. Closed by Stage 6.
- **No cross-invocation lock.** Two overlapping runs for one `org_id` would
  advance from the same cursor. Harmless at manual-trigger scale; needs an
  advisory lock before any cron fires alongside a manual trigger. Recorded
  against the first real deploy in ADR 0003.
- **The mock provider cannot push**, so the webhook has no real upstream —
  `tests/stage2-webhook.spec.ts` is what drives it. Extending Stage 1 to push
  would be scope drift into a finished stage.
- **The `expiredToken` chaos flag is survivable rather than fatal:** the route
  rotates its Bearer token on a 401. The flag still fires and is logged, but no
  longer fails a run. A deliberate call — a real client refreshes its token — and
  the closest this project comes to softening a failure mode.
- **Reconciliation depends on `raw_events.payload` keeping a readable `amount`.**
  An upstream rename would make quarantined value unrecoverable and turn the check
  red — arguably correct, but the failure would point here rather than at the
  schema change.
- **The volume baseline is per `org_id` across succeeded runs**, so a run that
  legitimately reads nothing drags the mean down. Less acute since the measure
  became `rows_read` rather than `rows_written`, but not gone.
- **`uniqueness` cannot fail** while `invoices` carries its
  `unique (org_id, external_id)` constraint. Kept deliberately (ADR 0005) so that
  a migration dropping the constraint does not silently take its verification too.

## What each stage cost, and what it caught

One line per stage: the defect worth remembering, not the narrative.

**Stage 1.** All 7 chaos flags verified live against a running server. Review
found a Stage 1 PRNG-determinism bug that made zero reconciliation drift
unreachable — found while capturing the Stage 3 baseline, fixed in Stage 2.

**Stage 2.** Built by two agents in parallel worktrees, reviewed as one merged
diff: 2 CRITICAL, 4 HIGH, 5 MEDIUM. The worst was a **spec** defect the PRD
itself specified — a `raw_events` idempotency key without `org_id`, which
silently discarded a second tenant's data. Also: non-atomic raw/downstream writes
leaving permanent orphans, a cursor regressing to null on a drained dataset, the
webhook poisoning the polling cursor, an unauthenticated trigger able to write to
any `org_id`, and one bad record aborting a whole run. ADR 0004 records the
resulting reversal.

**Local verification loop.** The first `supabase db reset` against an empty
database exposed two defects a hosted project's history was hiding: a migration
revoking a function no migration creates (aborting on any other database), and no
table or function grants anywhere — the hosted project pre-dated Supabase
removing the "auto-expose new entities" default and had been supplying them
invisibly. Fixed with an explicit least-privilege grants migration that revokes
the three Data API roles to nothing before granting back only what each uses
(`anon`: nothing; `authenticated`: SELECT only; `service_role`: verb-by-verb, no
DELETE or TRUNCATE). Verified by dumping the hosted project before and after: 24
blanket grants became 14 narrow ones, `anon` absent entirely.

**Stage 3.** Two false positives found during implementation rather than shipped:
the volume baseline measured `rows_written`, so a fully deduplicated re-run — the
most ordinary thing this pipeline does — scored −100% and failed; and an ad-hoc
invocation with no `run_id` was treated as a zero-row batch and failed the same
check. Both now abstain with a stated reason. Every check is asserted both ways —
that it passes on healthy data *and* that it can go red. A check that cannot go
red is decoration.

**Local dev loop.** Briefly containerised end to end, then pulled back to the
machine — ADR 0006 records both the reasoning and what the container round trip
was worth. Three findings survive it. `next build` segfaults under Bun on
Alpine, which is why the build runs on real Node in both places it happens.
Bun ignores `NODE_OPTIONS` and `bun run` drops a `--inspect` given to the
wrapper process, so the first debug script opened no inspector at all; and
Bun's inspector returns an empty `/json/list`, so IntelliJ's Node.js attach
cannot see it — `task dev` runs Node for that reason. Containerised checks cost
~40s against ~14s on the machine and required the Supabase stack for a
typecheck that touches no database, which is what ended the experiment.
