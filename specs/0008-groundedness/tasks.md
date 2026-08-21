# 0008 — Tasks

Lane owner: **W3-G**. Debt: D-27, D-03. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** `py/judge/`: claim decomposition → check against retrieved chunks → score (D-27)
- [ ] **T2** Judge output merged into `evals/thresholds.json` with a CI threshold (D-27, D-03)
- [ ] **T3** Eval case: uncited claim must fail groundedness (D-27)
- [ ] **T4** README judge claim reconciled via proof marker or removal (D-03)

## P1

- [ ] **T5** Judge latency/cost surfaced in `llm_calls`-style accounting (with spec 0011)
- [ ] **T6** Claim-level drill-down in eval reports (which claim, which chunk)

## P2

- [ ] **T7** Prompt-version diffing: judge results tied to prompt version for regression triage

