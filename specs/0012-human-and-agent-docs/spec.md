# 0012 — Human and Agent Docs

**Status:** partly shipped (7 of 10 tasks) · **Lane:** W5 (sequential) · **Debt closed:** D-39, D-01..D-10 verification mechanism

## Why

- ~5 000 lines of prose sit on ~15 000 lines of code with no 60-second entry (D-39).
- Documentation truth claims (D-01..D-10) drift because nothing verifies them (mechanism).

## User stories

**US-01** — As a reader, I want a README that reads in 3 minutes with proof markers, so I can trust what is real without reading the code.
**US-02** — As an agent, I want the anti-lying mechanism in `task check`, so a claim whose proof target vanished fails the build.
**US-03** — As a maintainer, I want docs that are physically separate from agent rules, so agents read AGENTS.md + specs, humans read README/docs, and they never drift into each other.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN any human doc (README, docs/*) WHEN verify-docs scans it THEN every claim carries a `<!-- proof: path[:symbol|#test] -->` marker whose target exists; `task check` fails otherwise (scripts/verify-docs.ts in `check`, D-39)
**AC-02** — GIVEN the docs WHEN counted THEN total prose ≤ 1 200 lines; README ≤ 180, RUNBOOK ≤ 150 (wc checks in verify-docs, D-39)
**AC-03** — GIVEN docs/ARCHITECTURE.md WHEN written THEN it is diagrams with ≤100-word captions, no essays (verify-docs pattern, D-39)
**AC-04** — GIVEN PROGRESS.md WHEN the docs lane lands THEN it is deleted; status comes from badges + DEBT.md (D-40 follow-through)
**AC-05** — GIVEN any D-01..D-10 claim (infra, queue, LLM-judge, CI, ADR 0008, PII/Vault, stories, roles, retrieved_chunk_ids, cron) WHEN verify-docs runs THEN each has a live proof marker; a claim with a dead target fails (D-01..D-10 recurrence guard)
**AC-06** — GIVEN LOCAL_DEV.md (754 lines) WHEN the runbook lands THEN it is folded into docs/RUNBOOK.md ≤150 lines (D-39)

## Invariants

- Agent rules (AGENTS.md, specs/) and human docs (README, docs/) are physically separate files.
- No lane writes prose into README/docs; docs are written once, here.
- Every proof marker resolves or `task check` is red.

## Out of scope

- Writing lane features.
- Human-readable documentation of code that does not exist yet (docs follow reality).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W5 (sequential)).
