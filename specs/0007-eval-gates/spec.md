# 0007 — Eval Gates

**Status:** proposed · **Lane:** W3-F · **Debt closed:** D-24, D-25, D-26, D-28, D-31

## Why

- Evals skip to exit 0 without keys, so a missing measurement reads as a pass (D-24).
- The injection case never scores the model's answer (D-26), `expect_no_filter` is declared but unchecked (D-28), and `min_similarity` exists in two places (D-31).
- Citation validity sits at 0.50 against a 0.95 bar (D-25).

## User stories

**US-01** — As CI, I want evals to be red when they skip, so a missing key never reads as a pass.
**US-02** — As a maintainer, I want the injection case to score the model's answer, so the gate tests behaviour, not retrieval alone.
**US-03** — As a maintainer, I want `expect_no_filter` asserted, so a declared filter is a real filter.
**US-04** — As a retrieval author, I want one `min_similarity` source, so the SQL default and the app cannot drift.
**US-05** — As an evaluator, I want a dataset of ≥60 cases, so the 0.791/0.803 margin stops being a coin flip.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN no API key WHEN `task evals` runs THEN the run exits non-zero; `--allow-skip` exists and is local-only (test: `evals/run.ts` exit code, D-24)
**AC-02** — GIVEN the injection eval case WHEN a model answers the poisoned prompt THEN the case scores the answer (tool choice + no harmful action), not just retrieval (eval case: `inj-01`, D-26)
**AC-03** — GIVEN an eval case declaring `expect_no_filter` WHEN the runner executes it THEN the runner asserts no filter was applied, else the case fails (assert in `evals/run.ts`, D-28)
**AC-04** — GIVEN the eval set on the chosen model WHEN it runs THEN citation validity ≥ 0.95 from `evals/thresholds.json` (D-25)
**AC-05** — GIVEN the dataset WHEN it is counted THEN ≥ 60 cases spanning metric/lookup/retrieval/unanswerable/injection, split across both tenants (D-31)
**AC-06** — GIVEN `min_similarity` WHEN the app and the SQL function use it THEN it comes from one source; the SQL default is removed or identical (grep: single constant, D-31)
**AC-07** — GIVEN a regression in retrieval, citation validity or safety WHEN CI runs evals THEN the merge is blocked (thresholds breach exits non-zero, D-25/D-31)

## Invariants

- Skip is red; a measurement that did not happen is not a measurement that passed.
- Deterministic metrics gate; model-dependent ones never count as passes.
- `task evals` is the identical command CI runs.
- Thresholds are versioned in `evals/thresholds.json`; a change is a visible diff.

## Out of scope

- The groundedness judge itself (spec 0008) — this spec wires its threshold in CI.
- Continuous online eval monitoring against live traffic.
- A human-labeling pipeline beyond hand-written cases.

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W3-F).
