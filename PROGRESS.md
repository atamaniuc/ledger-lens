# LedgerLens — Progress

Kanban-style progress tracker from current state to Definition of Done
for each stage. See [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md#roadmap-to-production)
for the full sequenced plan this board tracks.

## Current status

**Phase 0 (PRD) — done.** All 8 entries (Overview + Stages 1–7) written,
no placeholders. `Mock Provider` and `Ingestion & Transform` → Approved;
the rest → Draft pending their own implementation.

**Stage 1 (Mock Provider) — done, DoD passed.** See its checklist below.

**Stage 2 (Ingestion & Transform) — done, DoD passed.** See its checklist
below. Built by two parallel agents in separate worktrees (polling route,
webhook Edge Function), then reviewed as one merged diff — the review found
2 CRITICAL and 4 HIGH defects, all fixed, including one that was a **spec**
defect the PRD itself specified (`raw_events` idempotency key without
`org_id`, which silently discarded a second tenant's data). ADR 0004
records the resulting reversal of how records get written.

**Local verification loop — done.** The stack now runs end-to-end on one
machine: local Supabase (Docker) seeded with two tenants and two auth
users, `.env.local`, and a Playwright suite asserting each stage over HTTP
against the running app — 32 tests, all green, re-runnable from an empty
database. Setup, curl
recipes, and IntelliJ IDEA/DataGrip connection details are in
[`docs/LOCAL_DEV.md`](docs/LOCAL_DEV.md). Both databases now carry the
same six migrations. Standing up that loop found two reproducibility
defects that were invisible against the hosted project and would have
broken any fresh deploy — see the Done row below. Reviewed by
`cavecrew-reviewer` over two passes: 1 HIGH, 2 MEDIUM, all fixed. The
smoke script could truncate a non-local database if `DB_URL` were
overridden; its pagination assertion passed when the request failed on the
first page, a check that could not tell a clean walk from no walk at all;
and the first version of the loopback guard matched a substring, which
both rejected valid URLs without userinfo and would have accepted
`…@db.example.com/x?opt=127.0.0.1` and the host
`127.0.0.1.attacker.example`. The guard now parses the host out and
matches it exactly, refusing anything that is not a recognisable postgres
URL; ten URL forms were checked against it.

**Postman collection — done.** `postman/`, 20 requests / 47 assertions
across the same three stages, all green. It duplicates the Playwright suite
on purpose but is not redundant: it signs in through GoTrue for real, so
RLS is exercised with a genuine JWT rather than `set local role`. That
difference immediately paid for itself — the seed was writing NULL into
`auth.users.confirmation_token`, which GoTrue scans into a Go `string`,
so every sign-in failed with a 500 while every shell-side RLS check kept
passing. Fixed in the seed with the reason recorded there.

**Stage 3 (Data Quality & Reconciliation) — done, DoD passed.** Four checks
— freshness, volume, uniqueness, reconciliation — computed by one Postgres
function in one transaction and recorded per `run_id`, plus a standalone
route and an automatic verdict at the end of every ingestion run. See its
checklist below.

The stage's headline number is now measured live rather than by a script:
reconciliation drift is **exactly 0**, because the check compares against
*accounted* value — invoiced (47,942,632) plus quarantined-but-recoverable
(4,475,029) — against the provider's independent total (52,417,661).
Comparing against written invoices alone reports a **−8.54%** shortfall on
a perfectly healthy pipeline, which is why the naive framing was rejected
(ADR 0005). The before/after pair is in
[`docs/RECONCILIATION_BASELINE.md`](docs/RECONCILIATION_BASELINE.md):
**+2.65%** before idempotency, **0** after.

**End-to-end tests moved from shell to Playwright.** `scripts/smoke.sh`
was replaced by `tests/*.spec.ts`. Same assertions, but typed, named, and
unable to pass on a missing field — which is the failure mode the shell
version kept finding in itself (three times: a duplicated query parameter
that silently disabled three chaos assertions, a pagination check that
passed when the request failed, and a `!= "fail"` test that would have gone
green if the verdict stopped being produced). `whatIf()` runs a mutation
inside a transaction that is always rolled back, so every check is proven
able to go red without leaving the database changed.

**Next: Stage 4 (Dashboard + first `infra/` deploy).** Not started.

**Tracking convention:** one row per stage. `Agent` records which harness
role actually did the work (`main` = direct in the primary session, no
worktree; `worktree:<branch>` = isolated per-task agent per CLAUDE.md's
Parallel Execution rules; `codex` = second-opinion pass credited
alongside the primary agent). Existing "ready-made" boards this can graduate
to, once useful: **GitHub Projects** (native kanban, once the repo has a
GitHub remote — issues/PRs auto-track status) or OMC's `team` skill for
literal multi-agent parallel dispatch across worktrees. Neither is needed
yet at solo/sequential scale — this file is the board until one is.

---

## Backlog

| Stage | Depends on |
|---|---|
| 4 — Dashboard (+ first `infra/` deploy) | Stage 3 |
| 5 — RAG & Agent | Stage 4 |
| 6 — Evals (CI gate live → production bar met) | Stage 5 |
| 7 — Stretch (optional, independent items) | Stage 6 |

## In Progress

_(empty — Stage 4 not started yet)_

## Review

_(empty — Stage 3 passed review, moved to Done)_

## Done

| Item | Agent | Notes |
|---|---|---|
| Phase 0 — PRD, all 7 stages (`.claude/PRD.md`) | main | |
| Meta-harness (`scripts/harness/`, `prd`/`adr`/`design` skills) | main | |
| Database schema (`docs/DATABASE_SCHEMA.md`) | main | |
| Deployment plan (`docs/DEPLOYMENT.md`), Pulumi decision (ADR 0001) | main | |
| Project layout decision, no monorepo (ADR 0002, `DESIGN.md`) | main | |
| Next.js app scaffold + Supabase init | main | |
| **Stage 1 — Mock Provider** (`/invoices` + `/summary`, 7 chaos flags) | main + codex (review) | Build/lint clean, all 7 flags runtime-verified live. `make codex-review`: 5 findings, 4 fixed (DESIGN.md self-contradiction, missing `correlation_id` in RAG&Agent PRD, Stage 2/3 reconciliation-ordering contradiction, RLS-coverage wording), 1 accepted as a known limitation (no file lock in `new-design-section.sh`). Also fixed a real harness bug found along the way: `omc ask`'s `--agent-prompt` role is a fixed roster — `review` doesn't exist, `code-reviewer` does. |
| **Local verification loop** (`supabase/seed.sql`, `.env.local`, `scripts/smoke.sh`, `docs/LOCAL_DEV.md`, `make dev-up`/`smoke`/`verify`) | main | The first `supabase db reset` against an empty database exposed two defects that only a hosted project's history was hiding: (1) a migration revoking `public.rls_auto_enable()`, a function no migration creates — it is an artifact of that one project, so the run aborted on any other database; now guarded by a `to_regprocedure` check rather than dropped, since the revoke still matters where the function is real. (2) No table or function grants anywhere — the hosted project pre-dates Supabase's removal of the "auto-expose new entities" default and had been supplying them invisibly, so on a current project the ingestion route failed with `permission denied for table pipeline_runs`. Fixed with an explicit least-privilege grants migration that revokes the three Data API roles down to nothing before granting back only what each uses (`anon`: nothing; `authenticated`: SELECT only; `service_role`: verb-by-verb, no DELETE or TRUNCATE anywhere). Revoke-then-grant rather than grant-only so a project carrying the legacy default converges to the same privilege set instead of silently keeping a wider one. **Applied to the hosted project and verified against it**, not just reasoned about: a `supabase db dump` before the push showed `GRANT ALL` to `anon`, `authenticated`, and `service_role` on all six tables and both sequences (24 grants); the dump after shows 14 narrow grants, `anon` absent entirely, and no DELETE or TRUNCATE anywhere. Function-level privileges match local exactly. `supabase migration list` now shows all six migrations present in both. Also fixed `bun run lint` going red on the CLI's `supabase/.temp/` scratch bundle. |
| **Stage 2 — Ingestion & Transform** (polling route + webhook Edge Function, ADR 0003/0004) | worktree:stage-2-ingestion-route + worktree:stage-2-webhook (parallel) + main (schema, fixes) + code-reviewer | Two agents in isolated worktrees, merged and reviewed as one diff. Review: 2 CRITICAL + 4 HIGH + 5 MEDIUM, all addressed — tenant-scoped idempotency key (a **spec** defect the PRD itself specified), non-atomic raw/downstream writes leaving permanent orphans, cursor regressing to null on a drained dataset, webhook poisoning the polling cursor, unauthenticated trigger writing to any `org_id`, one bad record aborting the whole run. Also captured the reconciliation baseline PRD Stage 3 US-04 required during this stage, which surfaced and fixed a Stage 1 PRNG-determinism bug that made zero drift unreachable. |
| **Stage 3 — Data Quality & Reconciliation** (`run_data_quality_checks`, `/api/data-quality/run`, ADR 0005) | main + cavecrew-reviewer | Four checks in one Postgres function, one transaction, recorded per `run_id`; a verdict attached to every ingestion run without a scheduler. Two false positives were found and fixed during implementation rather than shipped: the volume baseline measured `rows_written`, so a fully deduplicated re-run — the most ordinary thing this pipeline does — scored −100% and failed; and an ad-hoc invocation with no `run_id` was treated as a zero-row batch and failed the same check. Both now abstain with a stated reason. The new table also inherited Postgres' default ACL (TRUNCATE/REFERENCES/TRIGGER for `anon`), which the Stage 2 privilege guard in the end-to-end suite caught immediately — exactly the divergence that guard was added for. |

---

## Stage 1 — Definition of Done checklist

Per `CLAUDE.md`'s Definition of Done:

- [x] Migration applied clean, advisors checked — N/A this stage (no DB table owned by Mock Provider)
- [x] Tests pass — chaos flags each runtime-verified: duplicates (~7.5% repeat rate), schemaDrift (100/100 number/string split), nullFields (7.0%), futureDates (3 records), rateLimit (429+Retry-After on request 10), serverError (500 on request 25), expiredToken (401 after request 15 on one token). No automated test suite yet — manual verification against a live dev server; worth a proper test file before Stage 2 builds on this.
- [x] Reviewer pass ran on the diff (`make codex-review`) — 5 findings, 4 fixed, 1 documented (see the Done row above)
- [x] RLS verified — N/A this stage (no RLS-scoped table involved)
- [x] `.claude/DESIGN.md` updated if scope drifted — no drift; implemented exactly to PRD acceptance criteria, no separate Mock Provider DESIGN.md section needed. No `tasks.md` either — executed directly (bounded scope, no `/omc-plan` ceremony needed for one stage's worth of file changes).
- [x] No secrets in diff — only `.env.example` (no real values) committed
- [x] Architecture decision changed mid-task? — none this stage (layout was Phase 1 / ADR 0002, already closed)

---

## Stage 2 — Definition of Done checklist

Per `CLAUDE.md`'s Definition of Done:

- [x] **Migrations applied clean, advisors checked.** Five migrations (core tables + RLS, `rls_auto_enable` lockdown, tenant-scoped idempotency + atomic ingest, pinned `search_path`, abandoned-run reaper). `get_advisors` security → zero lints after each; performance → only `unused_index` INFO notices, expected on tables with no query traffic yet. Two advisor findings were raised and fixed during the stage: a pre-existing `rls_auto_enable()` SECURITY DEFINER function callable by `anon`/`authenticated` via RPC, and a mutable `search_path` on the new `ingest_raw_event`.
- [x] **Tests pass.** `make check` → typecheck, lint, 27 unit tests across 4 files, all clean. Postgres-level verification against the live project covered all five `ingest_raw_event` outcomes plus the orphan-healing path (6/6 assertions PASS, including the cross-tenant case that failed before the fix). Not covered, stated plainly: the route handler end-to-end (needs `SUPABASE_SERVICE_ROLE_KEY`, absent here) and `deno check` (Deno not installed) — `make check` prints what it skipped rather than reporting a clean pass over a gap.
- [x] **Reviewer pass ran on the diff, findings resolved.** `code-reviewer` (Opus) on the merged `f041a81..HEAD`. 2 CRITICAL, 4 HIGH, 5 MEDIUM, 5 LOW. All CRITICAL/HIGH and every actionable MEDIUM fixed; the remainder are recorded as open questions in `.claude/DESIGN.md` rather than silently dropped.
- [x] **RLS verified.** Non-member query against `orgs` and `pipeline_runs` returns zero rows — empty, not an error, not masked data. Both new Postgres functions are `SECURITY INVOKER` with `EXECUTE` revoked from `public`/`anon`/`authenticated`.
- [x] **`.claude/DESIGN.md` updated for scope drift.** Rewritten after implementation: the write path moved into Postgres, which is a reversal of how the section originally described it, so it also got its own ADR (0004) rather than a silent edit. No `tasks.md` — executed as two parallel worktree tasks dispatched directly; noting that `/omc-plan --consensus` was skipped rather than pretending the artifact exists.
- [x] **No secrets in diff.** Two new shared secrets (`INGESTION_TRIGGER_SECRET`, `WEBHOOK_SHARED_SECRET`) documented in `.env.example` with no values.
- [x] **Architecture decision changed mid-task → new ADR.** ADR 0004 supersedes nothing but extends 0003: it records why single-record writes moved into a Postgres function, and why validation deliberately did not follow them there.
- [x] **Status docs synced in the same commit.** This file, `README.md` (badge + Project status), `docs/PROJECT_OVERVIEW.md` (Where things stand + roadmap).

### Carried forward, not silently dropped

Recorded in `.claude/DESIGN.md`'s open questions:

- No cross-invocation lock — two overlapping runs for one `org_id` would advance from the same cursor. Harmless at manual-trigger scale; needs an advisory lock before Stage 4's cron can fire alongside a manual trigger.
- No generated Supabase types, so `supabase.rpc()` return shapes are hand-written interfaces.
- No CI yet, so `make check` and `make e2e` are habits rather than gates. `deno check` in particular runs nowhere.
- The mock provider still can't push, so the webhook is proven by `simulate.sh` rather than driven end-to-end — the Playwright suite covers the polling route but not the Edge Function.
- `get_advisors` (Definition of Done item 1) is a hosted-project API that was reachable through an MCP server which is no longer connected, and it has no CLI or local equivalent. The grants migration is therefore not advisor-checked. Nothing it does is of a kind the advisors flag — it only narrows privileges — but that is reasoning, not a clean advisor run.

---

## Stage 3 — Definition of Done checklist

Per `CLAUDE.md`'s Definition of Done:

- [x] **Migration applied clean, advisors checked.** One migration (`data_quality_results` + RLS + explicit least-privilege grants + `run_data_quality_checks`). Applied from empty via `supabase db reset` repeatedly during implementation. `get_advisors` itself is unreachable — the MCP server that exposed it is no longer connected and there is no CLI equivalent — so the two lints it would raise here were checked directly against the catalog instead: the function is `SECURITY INVOKER` with `search_path` pinned to `''`, and the table has RLS enabled with a policy. Stated as what it is: an equivalent check, not an advisor run.
- [x] **Tests pass.** `make check` → typecheck, lint, 33 unit tests. the Playwright suite → 32 tests across three stages plus tenant isolation, all green from an empty database. Postman/newman → 67 assertions. Every check is asserted both ways: that it passes on healthy data *and* that it can go red — freshness on 25-hour-old data, reconciliation on an unaccounted record and on real value loss, volume on a batch 90% below a synthesised three-run baseline, plus the tolerated-band boundary. A check that cannot go red is decoration.
- [x] **Reviewer pass ran on the diff, findings resolved.** See the Done row and the commit.
- [x] **RLS verified.** `data_quality_results` has RLS on from the migration that created it, with the same org-membership policy as every other table. A non-member reads zero rows — empty, not an error. `anon` holds no privileges on it; `service_role` has SELECT and INSERT only, no DELETE, no TRUNCATE.
- [x] **`.claude/DESIGN.md` updated for scope drift.** Reconciled with the implementation after the fact: the design proposed a `thresholds.ts` holding the status arithmetic as pure functions, which was dropped once it became clear it would be a second source of truth for numbers the SQL function already applies. The volume measure changed from `rows_written` to `rows_read` for the reason recorded there. No `tasks.md` — executed directly; noting that rather than pretending the artifact exists.
- [x] **No secrets in diff.**
- [x] **Architecture decision → new ADR.** ADR 0005: one function for all four checks, and reconciliation against accounted rather than written value, with the measured numbers behind the rejected alternative.
- [x] **Status docs synced in the same commit.** This file, `README.md`, `docs/PROJECT_OVERVIEW.md`, and `docs/RECONCILIATION_BASELINE.md` (which now carries the live Stage 3 result alongside the Stage 2 capture).
