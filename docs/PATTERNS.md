# Patterns, Paradigms and Clean Code

An honest map of the idioms LedgerLens actually uses — and the ones it deliberately does not. Claims are proof-marked to real code; see docs/HARNESS.md for how lanes map to these.

## Vertical feature slices (the primary paradigm)

Each capability lives in its own slice — src/features/dashboard, src/features/agent, src/features/ingestion, src/features/provider, src/features/rag, src/features/admin — owning its queries, domain logic, and tests. A page imports a slice's query functions and components; there is no shared services layer that accumulates cross-cutting state.

- Proof: src/features/dashboard/queries.ts (fetchInvoicePage + filters) used by src/app/dashboard/page.tsx.
- Proof: src/features/agent/ owns chain, tools, budget, rbac, demo-answer; src/app/api/agent/chat/route.ts only composes them.

## Ports & adapters at the real boundaries (hexagonal where it pays)

Adapters sit at the points where the system meets the outside world; the domain never imports them directly.

| Boundary | Port | Adapter |
| --- | --- | --- |
| LLM providers | provider types + chain (src/features/agent/providers/types.ts, chain.ts) | OpenAI-compatible client (openai-compatible.ts), runtime provider resolution (provider-resolution.ts) |
| Embeddings | src/features/rag/embed.ts | supabase Edge Function call (signing in embedding-cache.ts) |
| Upstream provider | src/features/provider/chaos.ts + data.ts | mock provider with seven chaos flags |
| Compute | Python services (py/) | Modal for transcription, indexer/judge for evals |

The app is not Clean Architecture: there are no application/domain/infrastructure layers and no repository-per-table. Postgres (RLS + migrations) is the domain store; slicing by feature, not by layer, is what keeps the code navigable at ~15k lines.

## Tactical DDD

- Value objects instead of raw money: amounts are integer cents with currency (formatMoney in src/features/dashboard/metrics.ts); ids are branded strings via brand helpers, never bare strings in domain APIs.
- Invariants live in Postgres, not in application code: RLS policies, check constraints, and the reconciliation invariant (sum over the tenant's ledger equals the provider's independent total) are enforced by the schema and tested by SQL. See docs/DATA_MODEL.md.
- Aggregate-ish units: an ingestion run owns its batches and cursors (src/features/ingestion/run-start.ts, cursor.ts); concurrency is guarded by Postgres locks, not by in-process state.

## Other deliberate choices

- Server components first; client components are leaves ('use client' only where interactivity demands it: logout, copilot panel, admin settings form).
- Keyset pagination as URLs (after= cursor in src/features/dashboard/queries.ts) — pages are addressable and reload-safe.
- Deterministic demo mode: src/features/agent/demo-answer.ts pattern-matches intents and answers from real data through the same tools, marked demo:true — no canned prose.
- Feature flags as rows, not code: guardsEnabled / demoMode / providers live in copilot_settings (docs/ACCOUNTS.md, docs/QA-MANUAL.md).
- Single source of truth for design tokens (src/features/dashboard/design-tokens.ts) — no hardcoded hex/px in components.

## What we are NOT doing (and why)

- Clean Architecture layers — feature slicing keeps cohesion and removes indirection; layering would add six files per feature.
- Repository pattern per table — Supabase client + RLS is the repository; a wrapper would duplicate it.
- Event sourcing / CQRS — the write path is one Postgres transaction; the read path is the same schema with indexes. Complexity is not justified at this scale.
- Heavy DI frameworks — React server components and plain functions are the composition root.

<!-- proof: src/features/dashboard/queries.ts:fetchInvoicePage -->
<!-- proof: src/features/dashboard/metrics.ts:formatMoney -->
<!-- proof: src/features/agent/providers/types.ts -->
<!-- proof: src/features/agent/demo-answer.ts -->
<!-- proof: src/features/provider/chaos.ts -->
<!-- proof: docs/DATA_MODEL.md -->

