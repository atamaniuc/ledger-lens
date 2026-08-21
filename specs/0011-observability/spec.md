# 0011 — Observability

**Status:** proposed · **Lane:** W4-K · **Debt closed:** D-45

## Why

- Observability is logs only — no traces, metrics or alerts, so freshness and cost can silently degrade (D-45).

## User stories

**US-01** — As an operator, I want OTel traces across ingest → transform → quality → agent with `correlation_id` as the trace id, so one question maps to one trace.
**US-02** — As an operator, I want 4 metrics and 2 alerts, so freshness and cost cannot silently degrade.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a chat request WHEN it flows through retrieval and the agent THEN one OTel trace spans the chain, keyed by `correlation_id` (test: `tests/otel-trace.spec.ts`, D-45)
**AC-02** — GIVEN a pipeline run WHEN it completes THEN metrics `freshness_lag`, `ingest_error_rate`, `agent_p95_latency`, `llm_daily_cost` are emitted (test: metric emission, D-45)
**AC-03** — GIVEN `freshness_lag` above N or `llm_daily_cost` above cap WHEN the alert window closes THEN the alert fires (test: alert thresholds, D-45)
**AC-04** — GIVEN any log line WHEN it is written THEN it carries `correlation_id` — now asserted by tests, not only by convention (D-45)

## Invariants

- `correlation_id` is the trace id; spans reuse it, never mint new roots.
- Metrics have defined units and versioned thresholds.
- Alerts are wired to a real channel before the deploy lane closes.

## Out of scope

- Third-party APM UI; a minimal metrics endpoint/export suffices.
- Log aggregation beyond the existing `correlation_id` scheme.

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W4-K).
