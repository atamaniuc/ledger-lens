# Handoff — Current Work (resume point)

Read docs/HARNESS-QUICKSTART.md first (it explains how to resume a lane). This file says exactly what is done and what is next; it is superseded by specs/0014-dashboard-ux-and-role-model/tasks.md the moment that lane's P0 is committed.

## Where the repo stands

- main is squashed to a single refactor baseline (tag refactor-baseline-main) plus follow-up commits; work is pushed to origin/main.
- This round's changes (UNCOMMITTED at time of writing): app shell (src/components/app-header.tsx, logout-button.tsx), invoice filters (src/features/dashboard/queries.ts, src/app/dashboard/page.tsx, invoices-table.tsx), 3-role seeds (supabase/seed.sql, tests/helpers/db.ts CAROL), docs (ACCOUNTS.md, ARCHITECTURE-C4.md, PATTERNS.md, QA-MANUAL.md), spec lane 0014 + tasks.md.
- task check is green: typecheck, lint, 411 unit/component/story tests, 150 proof markers resolve.

## Next steps (in order)

1. Add README links to the four new docs (the docs links block near line 111).
2. Update DEBT.md with D-56..D-60 (open) and link spec 0014; tick T1..T8 in specs/0014/tasks.md after their evidence lands in the same commit.
3. Commit this batch (message: dashboard ux and role docs — spec 0014) and push.
4. Deploy is still blocked on VERCEL_API_TOKEN; after it: task infra-up, scripts/provision-hosted.sh, then manual QA on the hosted URL.

## How to continue in Claude Code / Codex

- First command: read AGENTS.md, then specs/0014-dashboard-ux-and-role-model/spec.md + tasks.md.
- Gate: run task check before any commit; task verify for the full integration suite (heavy).
- Do not re-derive context from this file's history — specs + DEBT.md + this file are the truth.
<!-- proof: specs/0014-dashboard-ux-and-role-model/tasks.md -->
<!-- proof: src/components/app-header.tsx -->

