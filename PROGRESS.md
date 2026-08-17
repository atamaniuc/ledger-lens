# LedgerLens — Progress

Kanban-style progress tracker from current state to Definition of Done
for each stage. See [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md#roadmap-to-production)
for the full sequenced plan this board tracks.

## Current status

**Phase 0 (PRD) — done.** All 8 entries (Overview + Stages 1–7) written,
no placeholders, statuses accurate (`Mock Provider` → Approved, rest →
Draft pending their own implementation).

**Stage 1 (Mock Provider) — done, DoD passed.** See the Stage 1 DoD
checklist below — every item checked, one honestly-flagged gap (no
automated test suite yet, verified manually instead).

**Next: Stage 2 (Ingestion & Transform).** Not started. First stage that
touches real Postgres tables (`raw_events`, `invoices`, `quarantine`,
`pipeline_runs`) — RLS must be enabled in the same migration that creates
each one, per the coverage gap Codex flagged during Stage 1 review (see
`docs/DATABASE_SCHEMA.md`).

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
| 2 — Ingestion & Transform | Stage 1 |
| 3 — Data Quality & Reconciliation | Stage 2 |
| 4 — Dashboard (+ first `infra/` deploy) | Stage 3 |
| 5 — RAG & Agent | Stage 4 |
| 6 — Evals (CI gate live → production bar met) | Stage 5 |
| 7 — Stretch (optional, independent items) | Stage 6 |

## In Progress

_(empty — Stage 2 not started yet)_

## Review

_(empty — Stage 1 passed review, moved to Done)_

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
