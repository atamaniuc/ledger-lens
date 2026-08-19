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
| 4 — Dashboard | done | Authenticated page over Stages 1–3, reading under the user's own JWT (ADR [0007](.claude/adr/0007-the-dashboard-reads-through-the-users-own-jwt-rls-is-the-only-authorization.md)) |
| 5 — RAG & Agent | done | Hybrid retrieval, a four-tool agent under the user's own JWT, and the copilot panel (ADR [0008](.claude/adr/0008-retrieval-embeds-in-the-edge-runtime-with-gte-small-hybrid-search-is-one-security-invoker-function.md), [0009](.claude/adr/0009-the-agent-executes-under-the-users-jwt-with-four-read-only-tools-and-no-send-capability.md)) |
| 6 — Evals + CI gate | done (POC) | 20-case dataset, versioned thresholds, `task evals`, one GitHub Actions workflow |
| 7 — Stretch | **not planned** | Optional from the start, and the core loop is what this project is for |

## What runs today

The stack runs end-to-end on one machine: local Supabase in Docker seeded with
two tenants and two auth users, the app in a `dev` container against the same
Linux/Bun environment that ships, an IDE-attachable debugger on `localhost:9230`,
and 94 Playwright tests asserting each stage over HTTP from an empty database,
alongside 146 unit tests.
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
- **`get_advisors`, 2026-08-19, after Stage 5:** security still clean, performance
  11 INFO `unused_index` — the same class on the same tables. It says nothing
  about Stage 5, because the Stage 5 migrations exist only locally; the hosted
  project stops at `20260819120000`. `supabase db lint --level warning` against
  the local stack, which does have them, reports no schema errors. Deploying
  Stage 5 and re-running advisors is the first close-out item that needs a
  hosted database.
- **Retrieval recall@5 = 1.00 (5/5), every target at rank 1.** Measured in Batch
  E, before the agent existed, so that ADR 0008's model choice could be reversed
  cheaply if it failed. Five hand-written queries is a floor, not a measurement —
  Stage 6's eval set is what turns it into one.
- **Relevance floor 0.78, measured not guessed.** Relevant queries scored
  0.820–0.897 against this corpus with `gte-small`; unrelated ones 0.701–0.757.
  Migration `20260819200000` carries the table. It is a property of *this* model
  and *this* corpus, so Stage 6 re-measures rather than inheriting the constant.

## Known limitations

Carried forward deliberately, not dropped:

- **Stage 7 (Stretch) will not be built.** It was optional from the first PRD
  draft, on the condition that the core loop was already real. It is, and the
  time is better spent on what Stages 1–6 already carry than on a seventh
  stage nobody asked for. The PRD entry stays as a record of what was
  considered.

- **No Storybook.** Deferred to Stage 7. It is a large install and a second
  build surface for a project with one page and no CI, and CLAUDE.md scopes
  stories to shared components. The four states a story would have shown —
  default, loading, empty, error — are each asserted in the end-to-end suite
  against the real page instead.
- **No turn has ever run against a real model.** This environment has no
  `ANTHROPIC_API_KEY`. The loop is tested against a stubbed model and a real
  database — which is the right way round for the safety claims, since every one
  of them is about capability rather than wording — and the route's own spec
  branches on the variable and currently asserts the 503 path. What is *not*
  demonstrated is that a real model answers sensibly. That is the first thing to
  do with a key.
- **`task index` is manual.** Nothing rebuilds the chunk index when ingestion
  writes new invoices, so the corpus goes stale silently between runs. The
  indexer is idempotent and content-hashed, so re-running it is cheap and safe —
  there is simply nothing that runs it.
- **The agent is single-turn.** The route takes one question and builds the
  message list from it; there is no conversation history, so a follow-up
  ("and the second one?") starts from nothing.
- **An account in two organizations is refused with a 409.** The tools carry no
  `org_id` filter — RLS decides what they see — so a two-org answer would be
  built from both while the audit rows named one. Refusing is honest; choosing
  is a Stage 6 feature.
- **Chunk citations do not drill down.** `[invoice:…]` opens the lineage drawer;
  `[chunk:…]` renders as a marker only, because the dashboard has no reader for
  corpus text. A link that led nowhere would be worse than one that does not
  claim to.
- **`chunks` is the one table where `service_role` holds `DELETE`.** Everything
  else is append-only because it records what arrived. `chunks` is a derived
  index of *current* text, and a document that loses a paragraph has to lose its
  tail chunks or retrieval keeps answering from text the document no longer
  contains. Stage 2's "no Data API role holds DELETE" invariant names this one
  allowance explicitly rather than being relaxed.
- **Changing the embedding model is a migration, not a config change.**
  `gte-small` fixes the column at `extensions.vector(384)`, so a swap means a
  column type change and a full re-embed. `chunks.embedding_model` is stored per
  row so a half-migrated corpus is a query rather than a memory.
- **The model price table is hand-maintained.** `lib/agent/pricing.ts` stamps
  cost into `llm_calls` at write time from a versioned constant
  (`PRICE_TABLE_VERSION`), so a row keeps the price actually paid — but nothing
  checks that constant against Anthropic's published rates.
- **The prompt-injection evidence is one fixture document.** The claim it
  supports is strong, because it rests on the tool registry rather than on the
  model's judgement — a compromised model can only *try*, and the attempt fails
  on the registry and lands in `audit_log`. But one poisoned document is one
  attack. A broader adversarial set belongs to Stage 6's evals.
- **The CI workflow has never run.** `.github/workflows/ci.yml` gates `task check`
  and `task evals`, but this repository has no git remote, so nothing has ever
  executed it. `task e2e` is still a local habit — Playwright needs the full
  stack plus a running app.
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

**Stage 4.** Three findings worth the space. GoTrue does not error on an
`emailRedirectTo` outside its allow-list — it substitutes `site_url`, so the
magic-link code landed on `/` and the flow died at a route with no handler.
Bun's inspector advertises CDP but returns an empty `/json/list`, so
IntelliJ's Node.js attach finds no target; and under `task dev` the useful
inspector is the forked server on 9231, not the CLI on 9230, which is why
breakpoints looked dead. And the Realtime bridge re-subscribed on every
refresh, because the server mints a fresh `correlation_id` per render and the
effect depended on it — a channel tearing itself down in response to the
refresh it had just caused, invisible because everything still reported
connected.

The design decisions that cost the most thought: the publication carries
`data_quality_results` as well as `pipeline_runs`, because the verdict is
written after `closeRun()` and a bridge watching runs alone refreshes before
it exists; the subscription never listens for DELETE, because RLS is not
applied to delete events and `*` would broadcast other tenants' primary keys;
and the panel keeps *missing*, *no verdict* and *fail* as three different
states, because collapsing any two turns the dashboard into a confident lie.

**Stage 5.** The defect worth remembering is that **the abstention mechanism
could never fire**, and it was found by writing the test for it rather than by
reading the code. A nearest-neighbour search always has nearest neighbours, so
"empty retrieval" — the condition US-06's whole behaviour hangs on — was a
state the system could not reach: "what is our parental leave policy?" came
back with five confident chunks about invoices. The bug was in retrieval, not
in the agent. Fixed with a measured relevance floor on the vector half only,
because a full-text match is a term the user actually typed and is evidence on
its own terms. recall@5 stayed 1.00.

Two more from the same stage. **The chunker silently dropped text:** its regex
tokenizer skipped spans it could not match, so "accrue interest at 1.5 percent
per month" lost the words around the decimal and `interest` vanished from the
index entirely. Caught by an assertion that a fused search reported no lexical
contribution — not by anything looking at the chunker. It is a character
scanner now, with a regression test asserting that no character is lost. And
**a correct citation came back unverified:** `search_chunks` returned the
invoice's uuid while the agent cites by external id, which it reads out of the
chunk text — so the panel put its "cites something that was not in anything the
copilot read" warning on top of a right answer. A warning that fires on correct
answers is worse than no warning; it teaches the reader to ignore the one
signal that matters.

The reviewer pass on the stage diff returned ten findings, all real. The two
that mattered most were behavioural rather than defensive: abstention fired on
the *first* empty search, discarding the half of a compound question
`list_invoices` would have answered; and the successful-tool audit write sat
inside the tool's own `try`, so a failing audit write was caught by the
tool-failure handler and recorded `tool_call_failed` for a call that had
succeeded — the trail mislabelled itself exactly when it was most needed. ADR
0009 carries the amendment, because it states the abstention mechanism in so
many words.

Two smaller ones are worth the line. The Edge Function's embedding batch dies
at 16 texts with an HTTP 546 `WORKER_LIMIT` and is fine at 8, which is why
`MAX_TEXTS` is 8 and not a round number. And PostgREST cannot infer a
*partial* unique index for `ON CONFLICT`, so the upsert keys became plain
unique constraints — the predicate was redundant anyway, since NULLs are
distinct.

Two process findings, both about gates that were not gates. The design-token
rule ("no hardcoded hex or px in a component") was asserted in two source
comments that both claimed `task check` enforced it; nothing did, and it is a
test now. And `stage4-dashboard.spec.ts`'s freshness assertion was a time bomb
— it expected `fresh` on first load without establishing it, so it passed the
day it was written and failed two hours and two minutes later.

**Stage 6.** Built as a proof of concept, deliberately: four deterministic
metrics that gate, and the model-dependent ones reported as `skip` rather than
counted as passes. It earned its keep on the first run — the dataset's "what is
the office wifi password?" scored 0.791 against a floor of 0.78, so an
unanswerable question retrieved five confident chunks and the abstention metric
went red. Migration `20260819200000` had measured that floor against three
unrelated queries; twenty cases found the fourth. The floor is 0.80 now, and
the margin between 0.791 unrelated and 0.803 for the weakest relevant chunk in
range is the honest reason `README.md`'s TODO asks for a bigger dataset. That
is the whole argument for an eval set, made by the eval set on its first run.

**Frontend pass.** shadcn/ui and TanStack Query were both listed in the README
long before either existed; the pass that added them found the collision worth
recording. `shadcn init` writes its own greyscale palette straight over
`--background`, `--foreground`, `--muted`, `--accent` and `--border` — the
dashboard's blue silently became grey, and `--muted` flipped meaning from
*muted text* to *a surface*. Keeping both palettes would have left two sources
of truth for one colour, and the copy is always what drifts. shadcn's token
names are now defined in terms of this project's, and where the two disagreed
this project moved: `text-muted` became `text-muted-foreground`, which is
shadcn's name for exactly what it already meant. The vendored components are
exempted from the design-token gate by name, one line each, so adding one stays
a visible decision.

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
