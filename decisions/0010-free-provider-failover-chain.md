# 0010: Free-tier provider failover chain

Status: Accepted

## Context

The project must run at zero cost. The copilot already supports Anthropic, Groq and NVIDIA NIM through one OpenAI-compatible adapter (`lib/agent/providers/index.ts`). Free tiers impose per-minute and per-day limits — Groq's 8,000 TPM is the budget `evals/run.ts` paces against — and a 429 currently ends the turn: `app/api/agent/chat/route.ts` maps the provider's rate-limit error straight to the client response.

## Decision

Provider selection is a **failover chain**, not a round-robin load balancer.

- An **ordered preference list from env**; on 429/5xx/timeout, the next provider in the chain is tried.
- A provider that returns 429 **with a `retry_after`** enters **cooldown for that window**.
- The provider and model that actually answered are **recorded on every `llm_calls` row** and surfaced in the API response.
- A **`fallback_rate` metric** makes silent degradation visible.
- **Explicitly out of scope:** rotating multiple API keys of the *same* provider to defeat its free-tier limit — it violates provider terms, and this project does not do that.

## Consequences

- **Answer quality is no longer uniform across a session**: a mid-turn fallback answers on a different model. The eval suite must therefore run **per provider**, and the gate is **per provider** — one provider and model per eval run, recorded in the run id, so a score is always attributable to one model.
- The chain adds one state object, the **cooldown map**, that must be **process-local** and therefore **resets on cold start** — the next request re-tries the preferred provider. Acceptable and self-correcting; it deliberately does not add a shared store.

## Alternatives considered

- **Single provider.** Dies on the free-tier limit; that is the status quo this decision replaces.
- **Round-robin load balancing.** Spreads load but mixes quality inside one turn and makes evals meaningless — a run cannot be attributed to one model.
- **Third-party router/gateway** (an OpenAI-compatible proxy service). Adds a dependency and a second place where API keys live, for a chain of three providers that a loop in `lib/agent/providers` already covers.
