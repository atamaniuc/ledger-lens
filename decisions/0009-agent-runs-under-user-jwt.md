# 0009: The agent executes under the user's JWT with four read-only tools and no send capability

Status: Accepted

## Context

The PRD bar: *a poisoned document cannot cause the agent to do harm — because no tool exists that could.* Two failure modes follow: cross-tenant reads (whatever scopes an agent's reads must hold for inputs nobody anticipated — ADR 0007/0008 answer this; the open question is whether the agent gets an exception for audit writes) and side effects (retrieval pulls untrusted text into the context; ADR 0008 guarantees it belongs to the caller's org, not that it is trustworthy (poison T17); once there, any instruction inside it is indistinguishable from the user's — the only reliable boundary is what the tools can do).

## Decision

The agent runs in a Next.js route handler under the calling user's JWT (`app/api/agent/chat/route.ts`). Every tool receives that request-scoped client. No `service_role` key exists anywhere in the chat path.

**Exactly four tools, and a test asserts the count:** `get_revenue_summary`, `list_invoices`, `search_documents` (reads), `draft_customer_email` (draft only).

**Three loop bounds, each ending the turn with a stated reason:** ≤6 tool-call steps, 30-second wall clock, token ceiling. **Every step audited, unforgeably:** `llm_calls`/`audit_log` written by `SECURITY DEFINER` functions that stamp `auth.uid()`; `authenticated` has **no** INSERT grant.

**Two behaviours are mechanisms, not instructions.** Empty retrieval short-circuits before the model composes (US-06) — amended: after **2 consecutive** empty steps (`EMPTY_STEPS_BEFORE_ABSTAINING`), plus a backstop discarding answers composed over no data. Citations verified deterministically: every cited id must be in the turn's context; otherwise the answer is marked **unverified**, never silently dropped (US-02).

**Provider amendment:** the vendor is configuration, not architecture. `lib/agent/providers` resolves a `ModelClient` from env; Anthropic, Groq and NVIDIA NIM (free tiers) are supported. **A named provider that is not configured is an error, not a fallback.**

## Consequences

- Prompt injection becomes uninteresting: a poisoned document cannot exfiltrate another tenant's data (RLS), write anything (no write tool, no INSERT grant), or reach the network (no tool does). Asserted against the tool registry, not model phrasing.
- The user is the only actor the system can act as; anything needing privilege the user lacks is out of reach, including plausible future features (an operator summary across tenants).
- Audit writes cost a `SECURITY DEFINER` call per step (up to twelve per six-step turn); a batched write would lose the rows that matter when a turn dies mid-step. No streaming (out of scope per PRD).
- `draft_customer_email` is the weakest claim — "no send capability exists" is one dependency away from false; re-check whenever an outbound integration is proposed. Multi-org users get HTTP 409 (the org is never guessed).

## Alternatives considered

- **Service-role key, agent filters `org_id` itself:** rejected — the tenant boundary becomes application code whose inputs are attacker-influenced; Stage 2 found this defect once (webhook path, CRITICAL).
- **Hybrid: user JWT for reads, service-role for audit writes only:** a bypass credential in the request path.
- **More tools, confirmation step for dangerous ones:** a larger claim on frontend code.
- **Trusting the system prompt:** fails against unanticipated injections; zero security weight.
- **Unbounded loop, platform timeout only:** termination invisible to the audit trail.
