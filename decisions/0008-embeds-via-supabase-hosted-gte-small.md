# 0008: Retrieval embeds via Supabase-hosted gte-small; hybrid search is one SECURITY INVOKER function

Status: Accepted

## Context

Stage 5 needs retrieval over a corpus before an agent worth trusting. Two questions are expensive to reverse once chunks exist.

**Where embeddings come from.** The stack already depends on Anthropic for generation, and Anthropic ships no embeddings API. Every option adds something: a second AI vendor, an API key on the ingest and query path, or a small local model at a quality cost. The Overview PRD's free-tier deploy constraint (Vercel/Supabase/Modal) applies to the vector path too: a provider that bills per token on every chat query is a different deployment story.

**How search is authorized.** ADR 0007 settled the dashboard (user JWT, RLS, no app-side `org_id` filtering). Retrieval is the harder version — a vector search cannot be eyeballed for a missing `where org_id = ...`. PRD US-03: org A's user cannot reach org B's chunks through the agent, even indirectly. The corpus is two things at once — text-only documents and invoice rows rendered to text — in one `chunks` table with a `source_kind` discriminator: one search path, one place authorization can go wrong.

## Decision

Embeddings are computed through **`Supabase.ai.Session('gte-small')` inside the Edge Function at `supabase/functions/embed`** — a **Supabase-hosted inference service reached from the Edge Function**, not a model running inside the runtime. 384 dimensions, no API key, no per-token cost, no second AI vendor. The function is authenticated by a shared secret header, exactly as `provider-webhook` is. Both sides go through it: indexing (`lib/rag/index-corpus.ts`) and query time (every chat turn embeds the question); the app cannot embed in-process.

`chunks.embedding` is `vector(384)` with an HNSW index (`vector_cosine_ops`) plus a generated `tsvector` column with a GIN index; every row carries `embedding_model text not null`, so a half-migrated corpus is detectable by query.

Hybrid search is one Postgres function, `search_chunks(query_embedding, query_text, match_limit)`: the vector half (cosine) and the lexical half (`websearch_to_tsquery` + `ts_rank`) fused by **Reciprocal Rank Fusion at k = 60** — RRF combines ranks and needs no normalization between a cosine distance and a `ts_rank`. It is **`SECURITY INVOKER`** with a pinned `search_path`, executable by `authenticated` and nothing else: RLS on `chunks` applies to the caller inside the function exactly as in a dashboard `select` — the function has no privilege of its own to leak.

**The recall bar is measured before the agent exists.** Recall@5 ≥ 0.8 (PRD) is scored at Batch E against a fixed five-query set on the seeded corpus. If `gte-small` cannot clear it, this ADR is amended and superseded there — not tuned around quietly.

## Consequences

- Every chat turn pays a network round trip to the Edge Function before retrieval; recorded in `llm_calls.latency_ms` from Batch H. If the function is down, retrieval is down and the agent abstains (US-06) — the already-specified failure mode.
- Changing the embedding model is a migration, not config: `vector(384)` is in the column type; a move changes the type, invalidates the HNSW index, and requires re-embedding. `embedding_model` makes a half-migration detectable; `task index` is idempotent by `content_hash`, so re-embedding is a re-run, not a backfill.
- Quality is the thing traded away: `gte-small` is 384-dim and the alternatives are better at retrieval. The bet — RRF plus a lexical half plus a small corpus clears 0.8 — is settled with a number at Batch E, before the agent is built. Reversal path is one function body and one column-type migration.
- `SECURITY INVOKER` is one word; the Batch E test (`tests/stage5-retrieval.spec.ts`, Globex user) fails loudly if the function is ever recreated `SECURITY DEFINER`.
- Retrieval inherits RLS's blind spot: visible ≠ trustworthy. A correctly visible chunk can still be a poisoned document (T17's fixture) — that is ADR 0009's problem, named here to keep the boundary explicit.

## Alternatives considered

- **Voyage AI (`voyage-3-lite`, 512 dims):** Anthropic's recommended pairing, materially better quality, generous free tier — but an API key on the query path (chat dies when a key expires or a quota hits) and a vendor to explain. Named reversal target if Batch E misses; the 512-dim column change is the known cost.
- **OpenAI `text-embedding-3-small` (1536 dims):** cheap per token but not free, and a second AI vendor in a story that is "Anthropic for generation, Postgres for everything else".
- **Vector-only retrieval:** rejected — the corpus is deliberately half invoice text, where exact identifiers (`INV-1042`, a customer name, a currency code) are the most likely query and the thing a small embedding model handles worst. The lexical half covers exactly that (PRD US-01).
- **Weighted score blending instead of RRF:** requires normalizing a cosine distance against a `ts_rank`; the weight would be a feel-chosen constant defended forever. RRF's k = 60 is the published default.
- **Search in the application (two queries, fuse in TypeScript):** moves the join across the network, splits the authorization boundary, puts `org_id` scoping back in app code — what ADR 0007 decided against.
- **`SECURITY DEFINER` with an explicit `org_id` parameter:** planner-cheaper, how many RPC search functions are written. Rejected — the caller-supplied `org_id` becomes the tenant selector, the exact CRITICAL defect Stage 2's review found in the webhook path. It does not get to come back as a search function.
