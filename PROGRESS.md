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

**Next: Stage 3 (Data Quality & Reconciliation).** Not started. The
project's actual differentiator. Its headline input is already captured and
banked — see [`docs/RECONCILIATION_BASELINE.md`](docs/RECONCILIATION_BASELINE.md):
drift goes from **+2.65% (+1,389,015 cents)** before idempotency to
**exactly 0** after. Capturing it during Stage 2 was a PRD requirement
(Stage 3 US-04) that the stage had initially missed, and doing it surfaced a
Stage 1 determinism bug that would have made zero drift unreachable — also
fixed and pinned by tests.

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
| 3 — Data Quality & Reconciliation | Stage 2 |
| 4 — Dashboard (+ first `infra/` deploy) | Stage 3 |
| 5 — RAG & Agent | Stage 4 |
| 6 — Evals (CI gate live → production bar met) | Stage 5 |
| 7 — Stretch (optional, independent items) | Stage 6 |

## In Progress

_(empty — Stage 3 not started yet)_

## Review

_(empty — Stage 2 passed review, moved to Done)_

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
| **Stage 2 — Ingestion & Transform** (polling route + webhook Edge Function, ADR 0003/0004) | worktree:stage-2-ingestion-route + worktree:stage-2-webhook (parallel) + main (schema, fixes) + code-reviewer | Two agents in isolated worktrees, merged and reviewed as one diff. Review: 2 CRITICAL + 4 HIGH + 5 MEDIUM, all addressed — tenant-scoped idempotency key (a **spec** defect the PRD itself specified), non-atomic raw/downstream writes leaving permanent orphans, cursor regressing to null on a drained dataset, webhook poisoning the polling cursor, unauthenticated trigger writing to any `org_id`, one bad record aborting the whole run. Also captured the reconciliation baseline PRD Stage 3 US-04 required during this stage, which surfaced and fixed a Stage 1 PRNG-determinism bug that made zero drift unreachable. |

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
- No CI yet, so `make check` is a habit rather than a gate. `deno check` in particular runs nowhere.
- The mock provider still can't push, so the webhook is proven by `simulate.sh` rather than driven end-to-end.
