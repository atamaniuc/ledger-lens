# Stage 5 — RAG & Agent: task list

**Status: in progress — Batches A through J done. The agent is built, its safety claims are tested, and the panel is on the dashboard; close-out (K) remains, and it is the first thing that needs an `ANTHROPIC_API_KEY`.** Stage 4's list is archived at
[`.claude/tasks/stage-4-dashboard.md`](.claude/tasks/stage-4-dashboard.md) as the
record of what was planned against what shipped.

Requirements are the "## RAG & Agent" entry in `.claude/PRD.md` (US-01…US-06).
Architecture is fixed by **ADR 0008** (retrieval) and **ADR 0009** (agent
execution), both written in Batch A before any code — this file records the
decisions those ADRs have to state, it does not replace them.
Branch: `stage-5-rag-agent`.

Tasks are grouped into batches. **A batch is one commit** — the tasks inside it
are one logical change, and splitting them would commit a contract without its
consumer. Every batch ends with a reviewer pass on its diff (Definition of Done
item 3) before the commit, not after.

Migrations stay sequential and single-agent (`CLAUDE.md`). Any batch containing
SQL loads `supabase:supabase-postgres-best-practices` first. Batches run in
order; there is a real dependency between each and the next.

---

## Decisions this stage is built on

Recorded here so the ADRs in Batch A have a source, and so a reader of this file
does not have to infer them from the tasks.

1. **Embeddings are computed by the Supabase Edge Runtime, not the app.**
   `Supabase.ai.Session('gte-small')`, 384 dimensions, no API key, no second AI
   vendor, no per-token cost. The consequence is real and has to be stated: the
   app cannot embed anything in-process, so *query-time* embedding is a network
   round trip to an Edge Function on every chat request, and a change of model
   changes the column type — `vector(384)` is not a detail that stays local.
2. **The corpus is both seeded documents and invoice-derived text**, in one
   `chunks` table with a `source_kind` discriminator. Documents give retrieval
   something keyword search over `invoices` cannot answer; invoice chunks keep
   `search_documents` and `list_invoices` answering about the same world.
3. **Hybrid search is one Postgres function**, `SECURITY INVOKER`, so RLS is the
   only authorization — the same decision ADR 0007 made for the dashboard, and
   the reason US-03 is testable rather than asserted.
4. **The agent runs under the calling user's JWT** in a Next route handler.
   No `service_role` anywhere in the chat path; a tool cannot reach a row the
   user's own dashboard could not.
5. **Audit rows are written by `SECURITY DEFINER` functions**, not by direct
   inserts under a permissive policy. A policy that lets `authenticated` insert
   into `audit_log` lets a user forge agent activity with the anon key and curl;
   a definer function that stamps `auth.uid()` itself does not.

---

## Batch A — Decisions on paper (one commit, docs only)

- [x] **T1** ADR 0008 — *Retrieval embeds in the Edge Runtime with `gte-small`;
      hybrid search is one `SECURITY INVOKER` Postgres function.* Context /
      Decision / Consequences / Alternatives (Voyage, OpenAI, and why a second
      vendor was rejected against the free-tier constraint). Consequences must
      name the two costs: a network hop on every query, and a model swap being a
      migration.
- [x] **T2** ADR 0009 — *The agent executes under the user's JWT with four
      read-only tools and no capability to send anything.* Records the step cap,
      the timeout, the token ceiling, and why safety is a capability boundary
      rather than a system-prompt instruction (PRD North Star).
- [x] **T3** `.claude/PRD.md` — flip "## RAG & Agent" from Draft to Approved and
      note US-07 of the Dashboard entry lands here, per the Stage 4 amendment.

**Verification:** `task adr` scaffolds both; links resolve; no other file changes.

---

## Batch B — Corpus schema (one commit)

- [x] **T4** Migration `stage5_documents_and_chunks`: `create extension if not
      exists vector with schema extensions`; `documents` (`org_id`, `title`,
      `kind`, `body`, `content_hash`, timestamps); `chunks` (`org_id`,
      `chunk_no`, `content`, `content_hash`, `embedding
      extensions.vector(384)`, `embedding_model text not null`).
      `embedding_model` is not decoration: it is how a re-embed after a model
      change is detectable instead of silent.
      **Changed while writing it, and this is the line that says why:** the
      planned polymorphic `(source_kind, source_id)` pair with a
      `unique (org_id, source_kind, source_id, chunk_no)` key became two
      nullable foreign keys — `document_id`, `invoice_id` — with a
      `num_nonnulls(...) = 1` check, two partial unique indexes, and
      `source_kind` as a *generated* column. A polymorphic id cannot carry a
      foreign key or `ON DELETE CASCADE` against two tables at once, so the
      original shape would have left orphan chunks behind a deleted document
      and let the discriminator drift from what it discriminates. ADR 0008 does
      not name the key, so it needs no amendment.
- [x] **T5** Indexes in the same migration: HNSW on `chunks.embedding`
      (`vector_cosine_ops`), a generated `tsvector` column + GIN for the
      full-text half of the fusion, and `org_id` indexes on both tables.
- [x] **T6** RLS in the same migration — `enable row level security` on both,
      select-own-org policies following the Stage 2 shape
      (`org_id in (select org_id from memberships where user_id = (select auth.uid()))`).
- [x] **T7** Grants in the same migration, following
      `20260818094500_stage2_explicit_data_api_grants.sql`: `anon` nothing,
      `authenticated` SELECT only, `service_role` verb-by-verb.
- [x] **T8** `docs/DATABASE_SCHEMA.md` — both tables documented; `task types`
      regenerated and committed with the migration.

**Verification (done):** `task dev-reset --yes` applied clean from empty;
`task check` and `supabase db lint --level warning` green; generated types
regenerated and committed. In `psql`, impersonating `authenticated`: Acme's
user sees only Acme's chunk, Globex's only Globex's, a signed-in user with no
membership sees zero rows rather than an error, and `anon` is refused at the
grant before any policy runs. Both halves of `chunks_exactly_one_source`
reject as expected, and `source_kind` / `content_tsv` populate themselves.

`get_advisors` is a **hosted-project** check and the Stage 5 migrations have
not been pushed there — it is re-run against the 2026-08-18 baseline at
close-out (Batch K), not per batch.

**Files:** 1 migration, `docs/DATABASE_SCHEMA.md`, generated types.

---

## Batch C — The embedding function (one commit)

- [x] **T9** **Spike first, before writing anything else in this batch:** confirm
      `Supabase.ai.Session('gte-small')` is available in the Edge Runtime version
      this repo pins, and that it returns 384 floats. If it is not, stop and
      amend ADR 0008 — the fallback is Voyage `voyage-3-lite` and it changes the
      column type, so it cannot be discovered in Batch F.
- [x] **T10** `supabase/functions/embed/index.ts` — POST `{ texts: string[] }`
      → `{ embeddings: number[][], model: 'gte-small' }`. Shared-secret header
      check like `provider-webhook`; batch size cap; rejects an empty array
      rather than returning an empty success.
- [x] **T11** `config.toml` `[edge_runtime.secrets]` entry + `supabase/.env` +
      `.env.example` documentation for `EMBED_SHARED_SECRET`, matching the
      two-copies note the webhook secret already carries.
- [x] **T12** `lib/rag/embed.ts` — the app-side client for T10, with the timeout
      and one retry. Unit-tested against a stubbed fetch.

**Verification (done):** T9 answered yes — `supabase-edge-runtime-1.74.3`
returns 384 floats from `gte-small`, so ADR 0008 stands and Voyage stays a
fallback rather than a correction. `task deno-check` now covers both Edge
Functions. Against the running stack: no secret and a wrong secret both 401,
an empty `texts` array is a 400 rather than an empty success, and a two-text
batch returns two 384-wide vectors. `bun test lib/rag` covers the retry
policy (5xx retried once, 4xx never), the abort-on-timeout path, and both
malformed-response guards.

**One thing the plan did not anticipate:** a new function directory is not
picked up by hot reload — the Edge Functions container binds its list at
start, so `supabase stop && supabase start` is required once. Recorded in
Batch K's docs pass rather than fixed; it is a CLI behaviour, not ours.

**Files:** 1 Edge Function, `config.toml`, `supabase/.env.example`,
`.env.example`, `scripts/write-env-local.sh`, `docs/LOCAL_DEV.md`,
`Taskfile.yml`, `lib/rag/embed.ts` + test.

---

## Batch D — Chunking, indexing, corpus (one commit)

- [x] **T13** `lib/rag/chunk.ts` — deterministic chunking (fixed size + overlap,
      no randomness, no model call). Unit tests assert the same input yields the
      same chunk boundaries, because Stage 6's eval set is only stable if this is.
- [x] **T14** `lib/rag/index-corpus.ts` — idempotent indexer over both sources:
      renders each `invoices` row to one chunk, chunks each `documents.body`,
      embeds via T12, upserts on `(org_id, source_kind, source_id, chunk_no)` and
      **skips rows whose `content_hash` is unchanged**. Re-running indexes zero
      new chunks — the same bar Stage 2's US-03 set for ingestion.
- [x] **T15** `scripts/index-corpus.ts` + a `task index` entry, service-role
      only, never reachable from the browser.
- [x] **T16** Seed corpus in `supabase/seed.sql` (fixed UUIDs, as the existing
      seed does): per-org documents whose content is *not* derivable from
      `invoices` — payment terms, a dispute note, a month-end memo — for both
      Acme and Globex, so US-03's cross-tenant test has something to fail on.
- [x] **T17** One deliberately **poisoned document** in Acme's seed, containing a
      plain-text instruction to exfiltrate or send something. It is a fixture,
      not an accident, and it is what Batch I's test points at. Commented as such
      in the seed so nobody "fixes" it later.

**Verification (done):** from an empty database, seed + ingestion for both
tenants + `task index` produced 366 chunks — Acme 4 document and 180 invoice,
Globex 2 document and 180 invoice. The second run reported
`chunksInserted: 0, embeddingsComputed: 0`. Editing a document's body
re-embedded exactly one chunk; growing it inserted three more; shrinking it
deleted the three stale ones. `bun test lib/rag` covers determinism, the
overlap, the hard-cut path, the no-progress guard, and the SQL-matching hash.

**Two things the plan did not anticipate, both now fixed in this batch:**

1. **The upsert key had to change** (`20260819170000`). Batch B's partial
   unique indexes cannot be inferred by `ON CONFLICT` unless the statement
   repeats their predicate, and PostgREST sends columns only — the indexer
   failed with *"there is no unique or exclusion constraint matching the ON
   CONFLICT specification"*. The predicate was doing nothing anyway: NULLs are
   distinct in a unique index, so plain constraints enforce exactly the same
   thing and are inferable.
2. **The embed batch cap is 8, not 64.** The Edge Runtime enforces a
   per-request CPU budget and a batch of 16 trips it — HTTP 546
   `WORKER_LIMIT`, no partial result. Measured, not guessed: 8 embeds in about
   a second. A full corpus index takes ~45s; a re-run over unchanged text
   takes ~1.5s.

**Files:** `lib/rag/chunk.ts`, `lib/rag/index-corpus.ts` (+ tests),
`scripts/index-corpus.ts`, `Taskfile.yml`, `eslint.config.mjs`,
`supabase/seed.sql`, 1 migration, `docs/DATABASE_SCHEMA.md`,
`docs/LOCAL_DEV.md`, and the batch-cap change in `lib/rag/embed.ts` +
`supabase/functions/embed/index.ts`.

---

### Checkpoint: corpus (after Batch D) — passed

- [x] `task check` green.
- [x] Both orgs have chunks; re-indexing is a no-op.
- [x] `supabase db lint` clean. `get_advisors` deferred to Batch K, as noted
      under Batch B — it reads the hosted project, which has none of this yet.
- [x] Diff reviewed before each commit.

---

## Batch E — Hybrid search (one commit)

- [x] **T18** Migration `stage5_search_chunks_rrf`: `search_chunks(query_embedding
      vector(384), query_text text, match_limit int)` — vector half ordered by
      cosine distance, lexical half by `websearch_to_tsquery` + `ts_rank`, fused
      by Reciprocal Rank Fusion (k = 60), returning `chunk_id`, `source_kind`,
      `source_id`, `content`, and both component ranks. **`SECURITY INVOKER`**,
      pinned `search_path`, executable by `authenticated` only.
- [x] **T19** `lib/rag/search.ts` — typed wrapper calling the RPC through the
      request-scoped user client, never the service client.
- [x] **T20** `tests/stage5-retrieval.spec.ts` — a fixed 5-query set with expected
      chunks; asserts each query's target is in the top 5; asserts a query only
      answerable from a document beats every invoice chunk; asserts as
      `bob@globex.test` that no Acme chunk is ever returned (US-03, the indirect
      path).

**Verification (done):** `task check` and the full `task e2e` suite green — 63
passed, 1 pre-existing skip. **recall@5 = 1.00 (5/5)**, and every target came
back at rank 1, so ADR 0008 stands as written: `gte-small` clears the bar
Stage 6 gates on, and Voyage stays a recorded fallback nobody has to take.
The honest caveat is that five hand-written queries over a small corpus is a
floor, not a measurement — Stage 6's dataset is what turns it into one.

**Three things this batch found, all fixed here:**

1. **The chunker was silently losing text.** The sentence tokenizer matched
   with a regex, and a regex *skips* what it cannot match: a decimal point
   ("accrue interest at 1.5 percent per month.") made it drop everything in
   front of the decimal, so the word `interest` never reached the index while
   the chunk still read as ordinary prose. Found because a fused-search
   assertion said the lexical half had contributed nothing. Now scanned rather
   than matched, with a regression test asserting no character is lost.
2. **Stage 2's privilege invariant went red, correctly.** "No Data API role
   holds DELETE" is no longer true — Batch B granted `service_role` DELETE on
   `chunks` deliberately. The test now names that one exception and the reason
   for it, so a second entry is still a regression.
3. **The spec cannot assume an index exists.** `stage2-ingestion.spec.ts`
   truncates `invoices ... cascade`, which empties `chunks` with it. The spec
   rebuilds the index in its own `beforeAll` (idempotent, ~1s when warm, ~45s
   from empty — hence the raised hook timeout).

**Files:** 1 migration, `lib/rag/search.ts` (+ test), 1 e2e spec.

---

### Checkpoint: retrieval (after Batch E) — passed

- [x] Retrieval works end to end under a real user JWT.
- [x] Cross-tenant retrieval returns empty, not an error — four differently
      phrased attempts by Globex's user, including asking for Acme documents
      by title, return zero Acme chunks.
- [x] recall@5 = 1.00 recorded. Above 0.8, so ADR 0008 needs no amendment.

---

## Batch F — The audit surface (one commit)

- [x] **T21** Migration `stage5_llm_calls_and_audit_log`: `llm_calls` (`org_id`,
      `correlation_id`, `model`, `input_tokens`, `output_tokens`, `cost_cents`,
      `latency_ms`, `tool_name`, `tool_args jsonb`, `step_no`, `created_at`) and
      `audit_log` (`org_id`, `correlation_id`, `actor_type`, `on_behalf_of`,
      `action`, `details jsonb`, `created_at`), both with RLS, read-own-org
      policies, and grants.
- [x] **T22** Same migration: `log_llm_call(...)` and `log_agent_action(...)` as
      **`SECURITY DEFINER`** functions that stamp `auth.uid()` and verify org
      membership themselves. No INSERT grant to `authenticated` on either table —
      decision 5 above; the point of an audit log is that its subject cannot
      write to it freely.
- [x] **T23** `lib/agent/audit.ts` — the app-side writers, taking the
      `correlation_id` from the request rather than minting a new one per call
      (`CLAUDE.md`: one `correlation_id` per request/step chain).
- [x] **T24** `docs/DATABASE_SCHEMA.md` + regenerated types.

**Verification (done):** in `psql` as `authenticated` — a direct
`insert into audit_log` and a direct `insert into llm_calls` are both refused
at the grant, before any policy runs; `log_agent_action` succeeds and stamps
`actor_type='agent'`, `actor_id='ledgerlens-agent'` and `on_behalf_of` from
`auth.uid()`; the same call against the other tenant's `org_id` is refused;
Globex's user sees zero rows in both tables; `anon` cannot read either.
`task check` green, including the pricing arithmetic and the audit wrappers.

**One decision made here rather than deferred:** a **failed audit write fails
the turn**. The PRD's counter-metric for this stage is "zero unaudited agent
actions", and swallowing the error would trade that guarantee for one answer.
Tested both writers.

**Files:** 1 migration, `lib/agent/audit.ts`, `lib/agent/pricing.ts` (+ tests),
`docs/DATABASE_SCHEMA.md`, generated types.

---

## Batch G — Four tools, and no fifth (one commit)

- [x] **T25** `lib/agent/tools/` — `get_revenue_summary`, `list_invoices`,
      `search_documents` (auto-execute, read-only) and `draft_customer_email`
      (returns a draft object; no transport exists in the repo to send it).
      Each takes the request-scoped user client. Zod schema per tool, converted
      once to the Anthropic tool JSON schema — one definition, not two.
- [x] **T26** `lib/agent/tools/index.ts` — the registry, plus a unit test that
      asserts the registry has **exactly four** entries. US-04 is a countable
      claim; a test is what keeps it one.
- [x] **T27** Per-tool unit tests including the cross-org case: each tool called
      with Globex's JWT and an Acme `org_id`/`invoice_id` returns empty, not
      another tenant's row.

**Verification (done):** `bun test lib/agent` — the registry test fails if a
fifth tool appears, if a tool declares an effect other than `read`/`draft`, or
if any tool's schema grows an `org_id`. `runTool` rejects a bad enum value and
an over-large `limit` **before** any query runs, asserted by a stub that
throws if it is touched. `tests/stage5-tools.spec.ts` runs all four against
the real database as both users; full `task e2e` green.

**What the cross-tenant test had to be rewritten to say:** both tenants ingest
the same mock-provider dataset, so an `external_id` legitimately exists in
both — Stage 2's tenant-scoped idempotency working as designed. The first
draft of the test asserted Globex got *no* row for Acme's identifier and was
wrong to. Identifiers prove nothing here; row ids do, and the documents corpus
(where the tenants genuinely differ) is where a leak shows up as a wrong
answer rather than a wrong id. The tool now returns `invoice_id` for exactly
that reason, which also gives US-02 something to cite.

**One thing tightened while writing it:** `get_revenue_summary` returns `null`
totals when the rows span more than one currency, instead of a sum across
incomparable units. A model handed a number will quote it.

**Files:** 4 tool modules, `types.ts`, registry + unit tests, 1 e2e spec.

---

## Batch H — The loop (one commit)

- [x] **T28** `lib/agent/loop.ts` — Anthropic tool-use loop: **max 6 steps, 30s
      wall-clock budget, token ceiling**, each bound enforced by the loop and
      each breach ending the turn with a stated reason rather than a truncated
      answer. Every step writes `llm_calls` via T23 under the request's single
      `correlation_id`.
- [x] **T29** `lib/agent/prompt.ts` — the system prompt as a versioned constant,
      so Stage 6 can diff a prompt change against an eval result.
- [x] **T30** `app/api/agent/chat/route.ts` — authenticated route, user JWT via
      `lib/supabase/server-client.ts`, `correlation_id` accepted or generated,
      one `audit_log` row per tool call with `actor_type='agent'` and
      `on_behalf_of=user_id`. No streaming (PRD out-of-scope).
- [x] **T31** Unit tests against a stubbed Anthropic client: step cap reached,
      timeout reached, token ceiling reached — three distinct terminations, three
      distinct recorded reasons.

**Verification (done):** `bun test lib/agent/loop.test.ts` drives all three
bounds against a stubbed Anthropic client — step cap, wall clock and token
ceiling each end the turn with their own `outcome` and their own stated
reason, and every row written in a turn carries one `correlation_id`.
`tests/stage5-agent-route.spec.ts` asserts the route's gates over HTTP:
unauthenticated is refused *before* the body is read (so a stranger cannot
tell a well-formed request from a malformed one), an empty or over-long
question is a 400, and an unconfigured deployment answers 503 rather than
failing inside the SDK.

**The environment this was built in has no `ANTHROPIC_API_KEY`,** so no turn
has yet run against the real model. Everything above is real; "the model
answers sensibly" is not yet evidence, and the route spec asserts the 503
branch while following the environment rather than pretending otherwise. The
first thing to do with a key is Batch K's end-to-end pass.

**One design point decided here:** a turn that ends on a bound writes its own
terminal `llm_calls` row — zero tokens, because no call was made, and the
`outcome` naming the bound. Without it the last row would say `ok` about a
turn that was cut short, which is the confusion `outcome` exists to prevent.

**Files:** `lib/agent/loop.ts`, `lib/agent/prompt.ts`,
`app/api/agent/chat/route.ts`, `.env.example`, loop tests, 1 e2e spec.

---

## Batch I — Citations, abstention, injection (one commit)

- [x] **T32** `lib/agent/citations.ts` — deterministic check that every cited
      `chunk_id`/`invoice_id` was actually in the retrieved context for that
      turn; anything else marks the answer **unverified** rather than dropping the
      citation silently (US-02).
- [x] **T33** Empty-retrieval abstention (US-06): retrieval returning nothing
      short-circuits to "I don't have data on that" **before** the model is asked
      to compose an answer. An instruction not to hallucinate is not a mechanism;
      not calling the model is.
- [x] **T34** `tests/stage5-agent-safety.spec.ts` — three cases: (1) a question
      whose answer is not in the corpus abstains; (2) a fabricated citation is
      flagged unverified; (3) the poisoned document from T17 is retrieved, the
      agent attempts nothing harmful because no tool could, and the attempt is
      visible in `audit_log`.

**Verification (done):** `task check` (137 unit tests) and the full `task e2e`
suite (83 passed, 1 pre-existing skip) green. The safety spec runs against the
**real database with a stubbed model**, which is the right way round: every
claim here is about capability — what the tools can do, what retrieval
returns, what lands in `audit_log` — and a test that greps a model's output
for a refusal only tests that model's phrasing on that day.

**Writing T33 found a defect in Batch E's search, not in the agent.** "Empty
retrieval" is a state a pure vector search never reaches: nearest-neighbour
search always has nearest neighbours, so "what is our parental leave policy?"
came back with five confident chunks about invoices and the abstention
mechanism could never fire. Fixed in `20260819200000` with a **measured**
relevance floor on the vector half (0.78; the migration carries the
similarity numbers for three relevant and three unrelated queries, which
separate cleanly at 0.82 / 0.76). The lexical half is deliberately not
filtered — a full-text match is a term the user actually typed. recall@5 is
still 1.00 with the floor in place, and three new tests cover the floor
firing, the floor being a parameter rather than a wall, and a relevant query
staying clear of it.

**On the injection case:** the poisoned document is genuinely retrieved (the
test asserts the text came back), the compromised model then tries
`send_email`, and the attempt fails on the registry with *"no tool named
send_email"* — visible in `audit_log` as a `tool_call_failed` row under the
turn's `correlation_id`. That is the PRD's North Star stated as a capability
rather than a hope.

**Files:** `lib/agent/citations.ts` (+ test), loop wiring, 1 e2e spec.

---

### Checkpoint: agent (after Batch I) — passed

- [x] `task check` and `task e2e` green (137 unit, 83 e2e).
- [x] Every US-01…US-06 acceptance criterion has a test naming it. **US-02**
      citations verified deterministically, both directions;
      **US-03** cross-tenant through every tool and through retrieval;
      **US-04** the registry count and the failed `send_email` attempt;
      **US-05** `llm_calls` + `audit_log` per step under one `correlation_id`;
      **US-06** abstention, with the relevance floor that makes it reachable;
      **US-01** recall@5 = 1.00 on the fixed query set.
- [x] Diff reviewed before each commit. **Not yet proven:** that a real model
      behaves well, because this environment has no `ANTHROPIC_API_KEY`.
      That is Batch K's first job.

---

## Batch J — The chat panel (one commit)

- [x] **T35** `components/dashboard/copilot-panel.tsx`. Six states — idle,
      asking, answered, **unconfigured**, failed, and the unverified-answer
      banner on top of an answer. Citations render through `segmentAnswer`
      (new, in `lib/agent/citations.ts`, with the same "loses no text"
      invariant the chunker has); an invoice citation resolves through
      `fetchInvoiceLineage` and opens the same `LineageDrillDown` drawer a
      metric tile opens, and a citation that resolves to nothing says so
      instead of opening an empty drawer.
      **Deviation from this plan, deliberate:** no TanStack Query. The
      dependency is in `package.json` but is used nowhere in the repo, and
      this is one imperative POST with no cache to share, nothing to refetch
      and nothing to invalidate — `useMutation` would mean adding a
      `QueryClientProvider` to wrap a single `fetch`. The panel uses
      `useState` + `fetch`, matching `LineageDrillDown`. See the open question
      below about the unused dependency.
- [x] **T36** Design tokens only. Also **made the gate real**: `app/globals.css`
      and `components/ui/status-badge.tsx` both claimed `task check` greps for
      hardcoded colours and pixels, and nothing did. `lib/dashboard/design-tokens.test.ts`
      now walks `app/` and `components/` for hex, `rgb()`/`hsl()`, and `px`,
      exempting `globals.css`. Mutation-checked: a planted `#ff0000` and `4px`
      both turn it red.
- [x] **T37** Wired into `app/dashboard/page.tsx`; the reserved-column comment
      is gone and the copilot sits above the live run list.

**Verification:** `task check` green (144 unit tests). `tests/stage5-agent.spec.ts`
(started here, finished in K) — 6 browser tests pass: the panel renders in the
third column, an empty question cannot be sent, a 503 reads as an operator
problem rather than a failed question and the dashboard is unaffected, a
verified invoice citation opens lineage, an invented citation stays visible and
flagged, an abstention does not render as an error, and a failed turn shows its
`correlation_id`. Screenshotted signed in as `alice@acme.test` with an answer
rendered.

**From the reviewer pass, fixed here:** a 200 response whose body is not an
answer (a dev-server error page, a proxy interstitial) was cast straight to the
result type, putting a `TypeError` inside render — and a throw during render
unmounts the whole client tree, so the panel would have taken the dashboard
down with it. Now validated and routed to the failed state, with a browser test
asserting the rest of the page survives. The freshness fix below also gained a
null guard: `max()` over no rows is null, and `ingested_at + null::interval`
would have nulled every row with nothing left to restore from.

**Also fixed here, out of plan:** `tests/stage4-dashboard.spec.ts`'s freshness
test was a time bomb — it asserted `fresh` on first load without establishing
it, so it passed when written and failed the moment the fixture aged past two
hours. It now shifts the org's ingest times forward (preserving relative order)
and restores them.

**Files:** 1 component, `app/dashboard/page.tsx`, `lib/agent/citations.ts`,
`lib/dashboard/queries.ts`, 2 test files. A `*.stories.tsx` is **not** required
— this is a one-off page section, not a shared component (`CLAUDE.md` Frontend).

---

## Reviewer pass on the stage diff (between J and K)

`/code-review medium` over the whole branch plus the working tree. Ten
findings, all real; none were disputed. Fixed in three commits:

- **An invoice cited from a search result could not be verified.** `search_chunks`
  returned only `invoice_id`, a uuid, while the agent cites by `external_id`,
  which it reads out of the chunk text — so a *correct* citation came back
  unverified and the new panel warned about a right answer. Migration
  `20260819210000` returns `invoice_external_id`; `citableIds()` was collecting
  the uuid for the same purpose and was unreachable.
- **Abstention fired on the first empty search**, discarding the half of a
  compound question `list_invoices` could have answered. Now waits for
  `EMPTY_STEPS_BEFORE_ABSTAINING` (2) consecutive empty steps, plus a backstop
  that discards an answer composed over an empty context. ADR 0009 amended,
  because the ADR states the mechanism.
- **The successful-tool audit write sat inside the tool's `try`.** `logAgentAction`
  throws on a failed audit write, so that throw was caught by the tool-failure
  handler, which told the model a successful tool had failed and wrote
  `tool_call_failed` for a call that succeeded — the trail was mislabelled
  exactly when it mattered.
- **The 30 s turn budget did not bound the model call.** The clock was only read
  at the top of the loop; the remaining budget is now the SDK request's timeout.
- **`draft_customer_email` used `maybeSingle()` with no `limit(1)`.** Both tenants
  hold the same `external_id`, so a two-org user turned a valid id into PGRST116.
- **A multi-org account was silently scoped to an arbitrary org** while the audit
  rows named one of them. The route returns 409 now; org selection is Stage 6.
- **`correlation_id` was taken from the body unvalidated** — a non-string reached
  a `text` column as a 500, and any caller could shadow another chain in the logs.
- **A wrong-shaped embedding response was retried**, paying a full round trip to
  fail identically. `EmbeddingError` now carries `retryable`.
- Two in the Batch J diff, fixed before it was committed: a non-JSON 200 body
  crashing render, and a null-`delta` guard in the freshness test.

---

## Batch K — Close-out (one commit)

- [ ] **T38** `tests/stage5-agent.spec.ts` — **started in Batch J**, which
      covers the panel's own states against a stubbed route. What is left needs
      a key: sign in, ask a real question, see a real answer with citations;
      and as `bob@globex.test`, no Acme content reachable through the panel.
      Fabricated rows cleaned up by a per-run tag, as
      `tests/stage4-dashboard.spec.ts` does, because Stage 3's reconciliation
      check is tenant-wide.
- [ ] **T39** `PROGRESS.md` — Stage 5 to done, Stage 6 to next, plus its "what it
      cost and what it caught" line and any new entry in the known-gaps list
      (expected: eval thresholds not yet enforced, that being Stage 6).
- [ ] **T40** Definition of Done close-out — reviewer pass on the full stage
      diff; `get_advisors` re-checked against the baseline; this file ticked;
      `README.md` link check only, no restatement.

---

## Close-out verification (run in this order)

1. `task dev-reset --yes` — every Stage 5 migration applies clean from empty.
2. `task index` twice — the second run writes zero chunks.
3. `task check` — typecheck, lint, unit, deno.
4. `task types-check` — generated types match the schema.
5. `task e2e` — the existing suite plus Stage 5's three specs.
6. `get_advisors` security + performance, diffed against the baseline.
7. Cross-tenant check by hand in `psql` on `chunks`, `llm_calls`, `audit_log`:
   empty for a non-owner `org_id`, not an error.
8. `git diff` scanned for secrets; no `service_role` outside `app/api/**` and
   `supabase/functions/**`.
9. Reviewer pass on the whole diff before the closing commit.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `gte-small` recall misses Stage 6's recall@5 ≥ 0.8 | High — gates the next stage | Measured in Batch E, before the agent exists; reversal is one Edge Function body + one column-type migration, recorded in ADR 0008 |
| Query-time embedding round trip adds latency to every chat turn | Medium | Inside the 30s budget by a wide margin; measured and recorded in `llm_calls.latency_ms` from Batch H |
| 30s agent budget vs. the deploy target's function timeout | Medium | The budget is enforced in the loop, not inherited from the platform; ADR 0009 states the number |
| Audit rows forgeable if written under a permissive insert policy | High — an audit log its subject can write is not one | `SECURITY DEFINER` writers, no INSERT grant to `authenticated` (T22) |
| Four-tool claim drifting as features get added | Medium | T26's registry test fails on a fifth tool |

## Open questions

- ~~Cost accounting in `llm_calls.cost_cents`~~ — closed in ADR 0009 and
  shipped in Batch F: `lib/agent/pricing.ts` holds a versioned table, cost is
  computed at write time, and a row keeps the price actually paid.
- ~~Which Anthropic model the agent runs on~~ — `claude-opus-5`
  ($5/$25 per MTok), recorded in `lib/agent/pricing.ts` as `AGENT_MODEL`
  alongside Sonnet 5 and Haiku 4.5 entries, so a change is a constant rather
  than a hunt. The token ceiling that goes with it is still Batch H's to set,
  against the latency the loop actually shows.
- **`@tanstack/react-query` is an unused dependency.** It has been in
  `package.json` since Stage 4 and nothing in `app/`, `components/`, `lib/` or
  `tests/` imports it; Batch J decided against introducing it for one POST. It
  should either be used by something in Stage 6 or dropped. Deliberately not
  swept into Batch J's commit — a dependency change is its own decision, not a
  side effect of building a panel.
