# 0002 — LLM Guardrails and Budget

**Status:** partly shipped (6 of 9 tasks) · **Lane:** W2-A · **Debt closed:** D-18, D-08, D-09

## Why

- `/api/agent/chat` has no rate limit and no spend bound, so one account can exhaust the free tier (D-18).
- The `admin/member/viewer` roles exist in the schema but nothing checks them (D-08).
- `llm_calls.retrieved_chunk_ids` is always NULL, so retrieval lineage is not queryable (D-09).

## User stories

**US-01** — As an operator, I want per-user and per-org rate limits on the chat route, so one account cannot exhaust the shared budget.
**US-02** — As an operator, I want a daily cost cap computed from `llm_calls`, so spend cannot exceed the free tier.
**US-03** — As a member, I want roles enforced on write-adjacent paths, so a viewer cannot do what an admin can.
**US-04** — As an analyst, I want `retrieved_chunk_ids` populated on every turn, so I can audit what context each answer used.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a user over the per-user rate limit WHEN they POST /api/agent/chat THEN the route returns 429 with `retry_after` (test: `tests/agent-rate-limit.spec.ts`, D-18)
**AC-02** — GIVEN an org over the daily cost cap derived from `llm_calls` WHEN a user in that org POSTs THEN the route returns 402 with `retry_after` (test: `tests/agent-cost-cap.spec.ts`, D-18)
**AC-03** — GIVEN a `viewer` role member WHEN they invoke a write-adjacent tool (or any tool outside the read allowlist) THEN the call is refused; `admin`/`member` succeed (SQL: migration `20260821100000`; test: `tests/rbac.spec.ts`, D-08)
**AC-04** — GIVEN a completed agent turn WHEN I query `llm_calls` THEN `retrieved_chunk_ids` is a non-empty array of ids that were in the retrieved context (SQL: `select count(*) from llm_calls where retrieved_chunk_ids is null` = 0 after a turn; unit: loop test, D-09)
**AC-05** — GIVEN the rate-limit and cap tables WHEN migrations run from empty THEN they apply cleanly and carry RLS like every other table (D-30 pattern)
**AC-06** — GIVEN limits and caps WHEN they are configured THEN values come from env via the one `config.ts`, not constants in the route (D-21 pattern)

## Invariants

- Limits are enforced server-side; the client cannot raise them.
- 429/402 always carry `retry_after`; never a generic 500 for a limit.
- Roles are checked on write paths; role removal from schema requires this spec's test to flip.
- `retrieved_chunk_ids` is never NULL after a turn that retrieved context.

## Out of scope

- Budget/limit UI.
- Streaming, cancellation, memory (D-44 — no owning spec; see lane report).
- Changing the tool allowlist (registry test in the agent lane guards it).

## Tasks

See `tasks.md` (P0/P1/P2, lane owner W2-A).
