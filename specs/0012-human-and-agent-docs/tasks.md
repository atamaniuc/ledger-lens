# 0012 — Tasks

Lane owner: **W5 (sequential)**. Debt: D-39, D-01..D-10 verification mechanism. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** `scripts/verify-docs.ts` + `<!-- proof: ... -->` markers wired into `task check` (D-39, D-01..D-10 guard)
- [ ] **T2** Selling README ≤180 lines: positioning, badges, 15s gif, 3 killer features with proof links, failure table, one-command quickstart, links (D-39)
- [ ] **T3** docs/ARCHITECTURE.md — diagrams only, ≤100-word captions (D-39)
- [ ] **T4** docs/RUNBOOK.md ≤150 lines; LOCAL_DEV.md folded in (D-39)
- [ ] **T5** docs/DECISIONS.md — one-line index of decisions/ (D-39)
- [ ] **T6** Delete PROGRESS.md; status = badges + DEBT.md (D-40)
- [ ] **T7** Proof markers on every D-01..D-10 claim; dead claims fixed or removed (D-01..D-10 mechanism)

## P1

- [ ] **T8** Failure-mode table (“how it breaks”) with the system's response
- [ ] **T9** Screenshot/gif pipeline documented so badges and media regenerate

## P2

- [ ] **T10** Doc freshness job in CI (verify-docs as a scheduled check)

