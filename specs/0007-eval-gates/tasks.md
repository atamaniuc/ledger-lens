# 0007 — Tasks

Lane owner: **W3-F**. Debt: D-24, D-25, D-26, D-28, D-31. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** skip = red: no-key runs exit non-zero; `--allow-skip` local-only flag (D-24)
- [ ] **T2** Injection case scores the model's answer (tool choice + refusal), not just retrieval (D-26)
- [ ] **T3** `expect_no_filter` asserted in the runner + a case that would trip it (D-28)
- [ ] **T4** Grow dataset 20 → ≥60 cases, tenant-split like the current 20 (D-31)
- [ ] **T5** Single `min_similarity` source; fold or remove the SQL default (D-31)
- [ ] **T6** Drive citation validity ≥ 0.95 on the chosen model; keep the failing reading visible until true (D-25)

## P1

- [ ] **T7** Wire the groundedness judge output into `evals/thresholds.json` (with spec 0008)
- [ ] **T8** Multi-tool assertions: a case may require >1 tool per question (extends tool-choice metric)

## P2

- [ ] **T9** Cost + p95 latency reported as measurements (not gates) once observability lands (spec 0011)

