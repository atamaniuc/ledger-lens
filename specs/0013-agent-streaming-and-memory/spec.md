# 0013 — Agent Streaming, Cancellation and Memory

**Status:** shipped · **Lane:** W3 (P1, after the gates in 0007 are green) · **Debt closed:** D-44

## Why

- The chat route answers with one JSON body after the whole turn finishes
  (`app/api/agent/chat/route.ts:111`), so a two-step turn shows nothing for
  seconds — the copilot looks broken while it is working.
- `ModelClient` is non-streaming by construction (`providers/types.ts:23-27`),
  and the only aborts in the system are internal timeouts: a user who closes
  the panel still pays for the turn.
- The agent is single-turn: the route builds the message list from one question,
  so "and the second one?" starts from nothing.

## User stories

**US-01** — As an analyst, I want tokens and tool steps to appear as they happen, so I can tell the difference between thinking and hanging.
**US-02** — As an analyst, I want to cancel a running answer, so a wrong question costs nothing more.
**US-03** — As an analyst, I want a follow-up question to see the previous turn, so I can ask "and the second one?".
**US-04** — As an operator, I want a cancelled turn to be audited as cancelled, so the audit trail never claims an answer that was never delivered.

## Acceptance criteria (Given / When / Then)

**AC-01** — GIVEN a question WHEN I POST /api/agent/chat with `Accept: text/event-stream` THEN step events arrive before the final answer, and the non-streaming JSON contract still works for the eval runner (test: `tests/agent-streaming.spec.ts`)
**AC-02** — GIVEN a streaming turn WHEN the client aborts the request THEN the loop stops within one step, no further provider call is made, and `llm_calls.outcome` for that turn is `cancelled` (test: `tests/agent-cancel.spec.ts`; SQL: `select outcome from llm_calls order by id desc limit 1`)
**AC-03** — GIVEN a prior turn in the same conversation WHEN I ask a follow-up THEN the model receives the prior question and answer, bounded by a token budget that drops the oldest turns first (unit: loop history test)
**AC-04** — GIVEN a conversation WHEN it is stored THEN rows are `org_id`-scoped with RLS like every other table and carry `correlation_id` (SQL: RLS coverage test from D-30)
**AC-05** — GIVEN the eval suite WHEN it runs THEN scores are unchanged by the streaming path, because both paths share one loop (eval run before/after, same provider and model)

## Invariants

- One loop, two transports: streaming must not fork the agent's decision logic.
- Cancellation is cooperative and audited; a cancelled turn is never scored as an answer.
- History is bounded by tokens, never by trust: retrieved context is re-fetched, never replayed from the client.
- The provider chain (decision 0010) applies per step, including mid-stream failover for the first token only.

## Out of scope

- Multi-user shared conversations, titles, search over history.
- Client-side optimistic rendering of tool results.

## Tasks

See `tasks.md` (P1, lane owner W3).
