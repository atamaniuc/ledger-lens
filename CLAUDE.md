# LedgerLens — Workflow Rules

## Project
Ingestion → transform → quality/reconciliation → Next.js dashboard → RAG agent.
Postgres/Supabase (RLS by `org_id`, pgvector HNSW), Next.js 16 App Router, Playwright + `bun test`.
Every table: RLS on. Every log line: `correlation_id`. Every data row: `run_id`.

## Two tracks

**Track 1 — a change inside something that already exists** (component, route,
query, fix, refactor). Write the code, run `task check`, get a reviewer pass on
the diff, commit. No PRD, no ADR, no plan document. This is the default track
and most work belongs in it.

**Track 2 — a new stage, or a decision that is expensive to reverse** (schema,
RLS, auth, a public contract, a new dependency at the architecture level):

1. One paragraph in `.claude/PRD.md` — problem, users, success criteria, non-goals.
2. One ADR at `.claude/adr/NNNN-<title>.md` — Context / Decision / Consequences /
   Alternatives considered. The ADR *is* the design document; there is no separate
   design file to keep in sync.
3. A checklist in `tasks.md`, grouped into batches. **One batch is one commit.**
4. Build. Machine feedback is the first reviewer: typecheck, tests, `get_advisors`,
   the page actually rendering. Model review comes after the code runs, not before
   it exists.

Planning stops when the next step is obvious. A plan longer than the code it
describes is the code written twice.

## Delegation
- Locate ("where is X / what calls Y") → `cavecrew-investigator`.
- Edit, ≤2 files → `cavecrew-builder`. 3+ files or cross-cutting → do it directly
  or use `executor`.
- Review every diff before commit → `cavecrew-reviewer`, or `code-reviewer` when
  the diff needs architectural rationale rather than a findings list.

Consensus loops and second-model review are not part of the default process.
Reach for one only when a decision is both irreversible and genuinely contested —
at most one pass, and only for schema, RLS, or auth.

## Domain rules
- Any table / RLS / migration / pgvector work: load
  `supabase:supabase-postgres-best-practices` before writing SQL.
- No RLS bypass, no `service_role` key in client code, no cross-`org_id` query
  without an explicit filter.
- Agent tools: scoped, permission-checked, every step writes an `audit_log` row.
- New agent behavior ships with an eval dataset case and a CI threshold.
- Ingestion stays idempotent and cursor-based. Reprocessing needs a cursor reset
  justified in the commit message.
- Mock-provider failure modes (duplicates, drift, 429, 500) stay as regression
  tests. Never softened to make a run pass.

## Definition of Done
1. `task check` green; migrations apply clean and `get_advisors` shows no new
   warnings against the recorded baseline.
2. Reviewer pass on the diff, findings resolved.
3. RLS verified where the diff touches data: a non-owner `org_id` gets empty
   results, not error-masked data.
4. No secrets and no `service_role` key in the diff.
5. `tasks.md` ticked. A decision that changed mid-task gets a new ADR that
   supersedes the old one (`Status: Superseded by NNNN`) — never a silent edit.

## Documentation
`PROGRESS.md` is the only place that records what stage is active and what is
done. `README.md` and `docs/PROJECT_OVERVIEW.md` link to it and never restate it,
so there is nothing to keep in sync.

Docs are the deliverable, so they are written to be read: short, current, and
non-overlapping. `README.md` is the entry point, `docs/PROJECT_OVERVIEW.md` is
the architecture, `docs/LOCAL_DEV.md` is the runbook, `docs/DATABASE_SCHEMA.md`
is the reference, `.claude/adr/` holds the decisions. If something belongs in two
of them, it belongs in one and is linked from the other.

## Frontend
- Charts, metrics, heatmaps, sparklines: load the `dataviz` skill before coding.
- Design tokens in one file — no hardcoded hex or px in a component.
- A co-located `*.stories.tsx` is required for shared components (anything used by
  two or more surfaces), covering default, loading, empty and error. One-off page
  sections do not need one.

## Repo zones
`interview-preps/` is gitignored personal material: edit directly, no process, and
never a load-bearing link from a committed doc into it. Everything else is the
deliverable and follows the rules above.

Caveman output style applies to chat replies only. Code, comments, commit
messages, PR text and every document stay normal prose.

## Branches & commits
- Branch `stage-N-<short-desc>`. Conventional Commits (`feat:`, `fix:`, `test:`,
  `chore:`, `docs:`), scope in parens when useful.
- One logical change per commit: a migration, its RLS policy and its test are one
  commit, not three.
- No `--no-verify`, no force-push to `main`.
