# 0008: retrieval embeds in the Edge Runtime with gte-small; hybrid search is one SECURITY INVOKER function

Status: Accepted

## Context

Stage 5 needs retrieval over a corpus before it can have an agent worth
trusting. Two questions have to be answered before any of it is written, and
both of them are expensive to reverse once chunks exist in a table.

**Where embeddings come from.** The repo already depends on
`@anthropic-ai/sdk` for generation, and Anthropic ships no embeddings API —
there is no "use what we already have" answer here. Every option adds
something: a second AI vendor, an API key on the ingest *and* query path, or
a model small enough to run locally at a quality cost. The project-wide
constraint from the Overview PRD is a free-tier deploy (Vercel/Supabase/Modal),
and the honest reading of that constraint is that it applies to the vector
path too — an embedding provider that bills per token on every chat query is
not a free-tier deploy with an asterisk, it is a different deployment story.

**How the search is authorized.** ADR 0007 settled this for the dashboard:
the user's JWT is the only credential and RLS is the only authorization, with
no application code filtering by `org_id`. Retrieval is a harder version of
the same question, because a vector search is not a query a reader can eyeball
for a missing `where org_id = ...`. The PRD's US-03 asks for exactly this
property — org A's user cannot reach org B's chunks *through the agent, even
indirectly* — and a mechanism that depends on remembering a filter inside a
similarity query will not survive the sixth person to touch it.

The corpus itself is two things at once (decision recorded in `tasks.md` and
seeded in Batch D): documents that exist only as text, and invoice rows
rendered to text. Both live in one `chunks` table with a `source_kind`
discriminator, which means one search path serves both and there is only one
place where authorization can be got wrong.

The local stack is Supabase CLI 2.115.0, Postgres 17, Edge Runtime on Deno 2.

## Decision

**Embeddings are computed by the Supabase Edge Runtime**, via
`Supabase.ai.Session('gte-small')` inside a Deno Edge Function at
`supabase/functions/embed`. 384 dimensions, no API key, no per-token cost, no
second AI vendor in the architecture. The function is authenticated by a
shared secret header, exactly as `provider-webhook` is.

Both sides of the system go through that one function:

- **Indexing** (`lib/rag/index-corpus.ts`) embeds document chunks and
  invoice-rendered chunks in batches.
- **Query time** — the agent embeds the user's question through the same
  endpoint on every chat turn. The app cannot embed in-process; `gte-small`
  exists in the Edge Runtime and nowhere else in this stack.

`chunks.embedding` is `vector(384)` with an HNSW index (`vector_cosine_ops`),
alongside a generated `tsvector` column with a GIN index. Every chunk row
carries `embedding_model text not null`, so a row embedded by a different
model is identifiable by a query rather than by memory.

**Hybrid search is one Postgres function**, `search_chunks(query_embedding
vector(384), query_text text, match_limit int)`, which runs the vector half
(cosine distance) and the lexical half (`websearch_to_tsquery` + `ts_rank`)
and fuses them with Reciprocal Rank Fusion at k = 60. It is
**`SECURITY INVOKER`** with a pinned `search_path`, executable by
`authenticated` and nothing else. RLS on `chunks` applies to the caller
inside the function exactly as it applies to a `select` from the dashboard —
the function has no privilege of its own to leak.

Reciprocal Rank Fusion rather than a weighted score blend, because RRF
combines *ranks* and needs no normalization between a cosine distance and a
`ts_rank` — two numbers on unrelated scales, whose relative weighting would
otherwise be a tuning constant nobody could justify.

**The recall bar is measured in Batch E, before the agent exists.** Stage 6's
PRD sets recall@5 ≥ 0.8 as a CI gate. A fixed five-query set is scored against
the seeded corpus at the point the search function lands, and the number goes
into that batch's commit message. If `gte-small` cannot clear the bar, this
ADR is amended and superseded there — not tuned around quietly, and not
discovered after four tools and a chat panel have been built on top of it.

## Consequences

**Every chat turn pays a network round trip before retrieval starts.** The app
sends the user's question to the Edge Function, waits for 384 floats, then
calls the search function. That hop is inside Stage 5's 30-second agent budget
by a wide margin, and it is recorded in `llm_calls.latency_ms` from Batch H
onward, so the cost is measured rather than assumed. But it is a real
dependency: if the Edge Function is down, retrieval is down, and the agent
abstains rather than answering from nothing — which is US-06's behaviour, so
the failure mode is at least the one already specified.

**Changing the embedding model is a migration, not a config change.**
`vector(384)` is in the column type. A move to any other model changes the
type, invalidates the HNSW index, and requires re-embedding the entire corpus.
`embedding_model` on every row makes a half-migrated corpus detectable, and
`task index` is idempotent by `content_hash`, so a re-embed is a re-run rather
than a hand-written backfill. That is the mitigation; it is not the same as
the cost being small.

**Quality is the thing being traded away.** `gte-small` is a 384-dimension
model and the alternatives below are better at retrieval. The bet is that RRF
plus a lexical half plus a small, well-scoped corpus clears 0.8 recall@5, and
Batch E is where the bet is settled with a number instead of an argument. If
it fails, the reversal path is one Edge Function body and one column-type
migration — which is precisely why the measurement happens before the agent.

**Authorization stops being reviewable by reading the SQL.** `SECURITY
INVOKER` is what makes this safe, and it is one word. The test in Batch E
(`tests/stage5-retrieval.spec.ts`, the Globex-user case) is the thing that
actually holds the property, and it fails loudly if the function is ever
recreated as `SECURITY DEFINER` for a performance reason that seemed good at
the time.

**Retrieval inherits RLS's blind spot.** RLS scopes what a caller can read; it
says nothing about what a caller *should* be asked to read. A chunk correctly
visible to the user can still be a poisoned document (T17's fixture). That is
ADR 0009's problem, not this one, and it is named here so the boundary between
the two is explicit: this ADR guarantees the agent cannot retrieve another
tenant's text, not that everything it retrieves is trustworthy.

## Alternatives considered

**Voyage AI (`voyage-3-lite`, 512 dims).** Anthropic's own recommended
pairing, materially better retrieval quality than `gte-small`, and a free tier
generous enough for this project's traffic. Rejected on the free-tier deploy
constraint read honestly: it puts an API key on the query path, which means
the chat feature stops working when a key expires or a quota is hit, and it
adds a vendor whose failure the project would have to explain. Kept as the
named reversal target — if Batch E's recall misses, this is what supersedes
the decision, and the 512-dimension column change is the known cost.

**OpenAI `text-embedding-3-small` (1536 dims, truncatable).** The best-known
baseline and cheap per token, but not free, and it introduces a second AI
vendor into a project whose story is "Anthropic for generation, Postgres for
everything else." A reader looking at the architecture would reasonably ask
why two providers are here, and "the embeddings one was familiar" is not an
answer worth defending in the interview this project exists for.

**Vector-only retrieval, no lexical half.** Simpler: one index, one ordering,
no fusion constant. Rejected because the corpus is deliberately half invoice
text, where exact identifiers (`INV-1042`, a customer name, a currency code)
are the most likely thing a user searches for and the thing a small embedding
model handles worst. The lexical half is not redundancy — it covers the exact
case the vector half is weakest at, which is what the PRD's US-01 means by
"not limited to exact keyword or pure-semantic matches alone."

**Weighted score blending instead of RRF.** Requires normalizing a cosine
distance against a `ts_rank`, and the weight would be a constant chosen by
feel and then defended forever. RRF needs no such constant; k = 60 is the
published default and the reason it can be left alone.

**Doing the search in the application** — two queries, fuse in TypeScript.
Rejected for the same reason ADR 0005 put the data-quality checks in one
Postgres function: it moves the join across the network, it makes the
authorization boundary two round trips instead of one, and it puts the
`org_id` scoping back into application code, which is exactly what ADR 0007
decided against.

**`SECURITY DEFINER` with an explicit `org_id` parameter.** Faster in the
sense that the planner sees no policy subquery, and it is how a lot of RPC
search functions are written. Rejected because it makes the caller's supplied
`org_id` the tenant selector — the same defect Stage 2's review found in the
webhook path, where `CLAUDE.md`'s "no cross-`org_id` query without an explicit
filter" was satisfied by a filter the *caller* supplied. That was a CRITICAL
finding once already in this repo; it does not get to come back as a search
function.
