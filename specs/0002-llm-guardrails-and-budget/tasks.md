# 0002 — Tasks

Lane owner: **W2-A**. Debt: D-18, D-08, D-09. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** Migration `20260821100000_llm_budget_and_limits.sql`: rate-limit + daily-cost tables (per-user, per-org), RLS, grants (D-18, D-30)
- [ ] **T2** Rate limit per user and per org on `/api/agent/chat` with 429 + `retry_after` (D-18)
- [ ] **T3** Daily cost cap computed from `llm_calls` with 402 + `retry_after` (D-18)
- [ ] **T4** RBAC gate: `viewer` cannot reach write-adjacent tools; test per role (D-08)
- [ ] **T5** Fill `retrieved_chunk_ids` in the loop's llm_calls write; unit test + SQL assertion (D-09)
- [ ] **T6** Limits/caps from env in `config.ts` (D-21 pattern)

## P1

- [ ] **T7** Budget report endpoint or dashboard read for operators (requires spec 0006 panel)
- [ ] **T8** Per-org hard ceiling in addition to the daily cap

## P2

- [ ] **T9** Alert when the daily cap is approached (feeds spec 0011 metric `llm_daily_cost`)

