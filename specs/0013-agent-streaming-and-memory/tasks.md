# 0013 — Tasks

Priorities: **P0** blocks the spec · **P1** required for the spec to be called done · **P2** nice to have.
Lane owner: W3. Debt: D-44.

## P1 — streaming transport
- [ ] Add a streaming method to `ModelClient` and implement it in the OpenAI-compatible adapter (SSE deltas) — keep the non-streaming method for the eval runner
- [ ] Emit step events (tool call, tool result summary, token deltas) from the one loop
- [ ] Route: content negotiation on `Accept`, `text/event-stream` path plus the existing JSON path
- [ ] `tests/agent-streaming.spec.ts`

## P1 — cancellation
- [ ] Thread the request `AbortSignal` into the loop and the provider call
- [ ] Audit a cancelled turn as `outcome = 'cancelled'` with the steps that did run
- [ ] `tests/agent-cancel.spec.ts`

## P1 — memory
- [ ] Migration: `conversations` and `conversation_turns`, `org_id`-scoped, RLS on, `correlation_id` carried
- [ ] Bounded history assembly (token budget, oldest turns dropped first)
- [ ] Unit test for the budget boundary

## P1 — UI
- [ ] Copilot panel renders streamed steps and a cancel button (coordinate with spec 0006 tokens)
- [ ] Empty / streaming / cancelled / error states have stories

## P2
- [ ] Mid-stream provider failover before the first token
- [ ] Resume a dropped stream from the last step
