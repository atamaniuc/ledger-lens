# 0013 — Tasks

Priorities: **P0** blocks the spec · **P1** required for the spec to be called done · **P2** nice to have.
Lane owner: W3. Debt: D-44.

## P1 — streaming transport
- [x] Add a streaming method to `ModelClient` and implement it in the OpenAI-compatible adapter (SSE deltas) — keep the non-streaming method for the eval runner
- [x] Emit step events (tool call, tool result summary, token deltas) from the one loop
- [x] Route: content negotiation on `Accept`, `text/event-stream` path plus the existing JSON path
- [x] `tests/agent-streaming.spec.ts`

## P1 — cancellation
- [x] Thread the request `AbortSignal` into the loop and the provider call
- [x] Audit a cancelled turn as `outcome = 'cancelled'` with the steps that did run
- [x] `tests/agent-cancel.spec.ts`

## P1 — memory
- [x] Migration: `conversations` and `conversation_turns`, `org_id`-scoped, RLS on, `correlation_id` carried
- [x] Bounded history assembly (token budget, oldest turns dropped first)
- [x] Unit test for the budget boundary

## P1 — UI
- [x] Copilot panel renders streamed steps and a cancel button (coordinate with spec 0006 tokens)
- [x] Empty / streaming / cancelled / error states have stories

## P2
- [x] Mid-stream provider failover before the first token
- [x] Resume a dropped stream from the last step
