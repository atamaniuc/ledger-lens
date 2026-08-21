# Handoff — Current Work (resume point)

Read docs/HARNESS-QUICKSTART.md first (it explains how to resume a lane). This file says exactly what is done and what is next; it is superseded by specs/0014-dashboard-ux-and-role-model/tasks.md the moment that lane's P0 is committed.

## Where the repo stands

- main is a squashed refactor baseline (tag refactor-baseline-main) plus follow-up commits; work is pushed to origin/main.
- Spec 0014 P0 is SHIPPED in commit fb0019e (dashboard shell, invoice filters, 3-role seeds, ACCOUNTS/C4/PATTERNS/QA-MANUAL docs, README links, DEBT.md D-56..D-60 open).
- task check is green: typecheck, lint, 411 unit/component/story tests, 173 proof markers resolve.
- Spec 0014 P0 tasks T1-T8 are ticked in specs/0014-dashboard-ux-and-role-model/tasks.md; P1 (T9-T10) and P2 (T11) are open.

## Next steps (in order)

1. Optional P1 of spec 0014: distinct empty-state for zero-result filters (T9), focus-visible sweep (T10).
2. Deploy is blocked on VERCEL_API_TOKEN: after it, run task infra-up, then scripts/provision-hosted.sh, then manual QA on the hosted URL (docs/QA-MANUAL.md scenarios S1-S10).
3. If a next lane starts, create specs/NNNN-<slug>/ per AGENTS.md and tick against specs/DoD.md.

## How to continue in Claude Code / Codex

- First command: read AGENTS.md, then specs/0014-dashboard-ux-and-role-model/spec.md + tasks.md.
- Gate: run task check before any commit; task verify for the full integration suite (heavy).
- Do not re-derive context from this file's history — specs + DEBT.md + this file are the truth.
<!-- proof: specs/0014-dashboard-ux-and-role-model/tasks.md -->
<!-- proof: src/components/app-header.tsx -->
