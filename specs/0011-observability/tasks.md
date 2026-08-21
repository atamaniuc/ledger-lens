# 0011 — Tasks

Lane owner: **W4-K**. Debt: D-45. P0 gates the lane; P1/P2 follow. A batch is one commit; every commit's message carries the D-XX or spec id. Ticked only against the DoD (`specs/DoD.md`).

## P0

- [ ] **T1** OTel SDK in `src/platform/obs/`; traces across ingest → transform → quality → agent (D-45)
- [ ] **T2** `correlation_id` as trace id end-to-end; test asserts one trace per request (D-45)
- [ ] **T3** 4 metrics: `freshness_lag`, `ingest_error_rate`, `agent_p95_latency`, `llm_daily_cost` (D-45)
- [ ] **T4** 2 alerts: freshness > N, cost > cap (D-45)

## P1

- [ ] **T5** Alert routing to a channel (email/slack) before deploy (spec 0010)
- [ ] **T6** Metrics exposed for the README badges (CI/evals/coverage)

## P2

- [ ] **T7** Trace sampling policy for the free tier

