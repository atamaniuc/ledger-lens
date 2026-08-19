# Stage 5 — RAG & Agent: task list

**Status: in progress — Batches A and B done.** Stage 4's list is archived at
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

- [ ] **T9** **Spike first, before writing anything else in this batch:** confirm
      `Supabase.ai.Session('gte-small')` is available in the Edge Runtime version
      this repo pins, and that it returns 384 floats. If it is not, stop and
      amend ADR 0008 — the fallback is Voyage `voyage-3-lite` and it changes the
      column type, so it cannot be discovered in Batch F.
- [ ] **T10** `supabase/functions/embed/index.ts` — POST `{ texts: string[] }`
      → `{ embeddings: number[][], model: 'gte-small' }`. Shared-secret header
      check like `provider-webhook`; batch size cap; rejects an empty array
      rather than returning an empty success.
- [ ] **T11** `config.toml` `[edge_runtime.secrets]` entry + `supabase/.env` +
      `.env.example` documentation for `EMBED_SHARED_SECRET`, matching the
      two-copies note the webhook secret already carries.
- [ ] **T12** `lib/rag/embed.ts` — the app-side client for T10, with the timeout
      and one retry. Unit-tested against a stubbed fetch.

**Verification:** `task deno-check`; `curl` the local function with and without
the secret (401); `bun test lib` covers T12's retry and timeout paths.

**Files:** 1 Edge Function, `config.toml`, `.env.example`, `lib/rag/embed.ts` + test.

---

## Batch D — Chunking, indexing, corpus (one commit)

- [ ] **T13** `lib/rag/chunk.ts` — deterministic chunking (fixed size + overlap,
      no randomness, no model call). Unit tests assert the same input yields the
      same chunk boundaries, because Stage 6's eval set is only stable if this is.
- [ ] **T14** `lib/rag/index-corpus.ts` — idempotent indexer over both sources:
      renders each `invoices` row to one chunk, chunks each `documents.body`,
      embeds via T12, upserts on `(org_id, source_kind, source_id, chunk_no)` and
      **skips rows whose `content_hash` is unchanged**. Re-running indexes zero
      new chunks — the same bar Stage 2's US-03 set for ingestion.
- [ ] **T15** `scripts/index-corpus.ts` + a `task index` entry, service-role
      only, never reachable from the browser.
- [ ] **T16** Seed corpus in `supabase/seed.sql` (fixed UUIDs, as the existing
      seed does): per-org documents whose content is *not* derivable from
      `invoices` — payment terms, a dispute note, a month-end memo — for both
      Acme and Globex, so US-03's cross-tenant test has something to fail on.
- [ ] **T17** One deliberately **poisoned document** in Acme's seed, containing a
      plain-text instruction to exfiltrate or send something. It is a fixture,
      not an accident, and it is what Batch I's test points at. Commented as such
      in the seed so nobody "fixes" it later.

**Verification:** `task dev-reset --yes && task index` twice — second run writes
zero chunks; `bun test lib` for T13/T14; chunk counts per org non-zero and
disjoint.

**Files:** `lib/rag/chunk.ts`, `lib/rag/index-corpus.ts` (+ tests),
`scripts/index-corpus.ts`, `Taskfile.yml`, `supabase/seed.sql`.

---

### Checkpoint: corpus (after Batch D)

- [ ] `task check` green.
- [ ] Both orgs have chunks; re-indexing is a no-op.
- [ ] `get_advisors` clean against baseline.
- [ ] Reviewer pass on Batches B–D as a whole before continuing.

---

## Batch E — Hybrid search (one commit)

- [ ] **T18** Migration `stage5_search_chunks_rrf`: `search_chunks(query_embedding
      vector(384), query_text text, match_limit int)` — vector half ordered by
      cosine distance, lexical half by `websearch_to_tsquery` + `ts_rank`, fused
      by Reciprocal Rank Fusion (k = 60), returning `chunk_id`, `source_kind`,
      `source_id`, `content`, and both component ranks. **`SECURITY INVOKER`**,
      pinned `search_path`, executable by `authenticated` only.
- [ ] **T19** `lib/rag/search.ts` — typed wrapper calling the RPC through the
      request-scoped user client, never the service client.
- [ ] **T20** `tests/stage5-retrieval.spec.ts` — a fixed 5-query set with expected
      chunks; asserts each query's target is in the top 5; asserts a query only
      answerable from a document beats every invoice chunk; asserts as
      `bob@globex.test` that no Acme chunk is ever returned (US-03, the indirect
      path).

**Verification:** `task e2e` including the new spec; the recall number from T20
is written into the batch's commit message, because Stage 6 will gate on it.

**Risk this batch resolves or exposes:** `gte-small` is a small model. If T20's
recall cannot clear the recall@5 ≥ 0.8 bar Stage 6's PRD sets, that is
discovered *here*, with a one-function reversal path, not after the agent is
built on top of it. A miss amends ADR 0008 rather than being tuned around
quietly.

**Files:** 1 migration, `lib/rag/search.ts` (+ test), 1 e2e spec.

---

### Checkpoint: retrieval (after Batch E)

- [ ] Retrieval works end to end under a real user JWT.
- [ ] Cross-tenant retrieval returns empty, not an error.
- [ ] recall@5 on the fixed query set recorded; if below 0.8, ADR 0008 amended
      before Batch F starts.

---

## Batch F — The audit surface (one commit)

- [ ] **T21** Migration `stage5_llm_calls_and_audit_log`: `llm_calls` (`org_id`,
      `correlation_id`, `model`, `input_tokens`, `output_tokens`, `cost_cents`,
      `latency_ms`, `tool_name`, `tool_args jsonb`, `step_no`, `created_at`) and
      `audit_log` (`org_id`, `correlation_id`, `actor_type`, `on_behalf_of`,
      `action`, `details jsonb`, `created_at`), both with RLS, read-own-org
      policies, and grants.
- [ ] **T22** Same migration: `log_llm_call(...)` and `log_agent_action(...)` as
      **`SECURITY DEFINER`** functions that stamp `auth.uid()` and verify org
      membership themselves. No INSERT grant to `authenticated` on either table —
      decision 5 above; the point of an audit log is that its subject cannot
      write to it freely.
- [ ] **T23** `lib/agent/audit.ts` — the app-side writers, taking the
      `correlation_id` from the request rather than minting a new one per call
      (`CLAUDE.md`: one `correlation_id` per request/step chain).
- [ ] **T24** `docs/DATABASE_SCHEMA.md` + regenerated types.

**Verification:** a direct `insert into audit_log` as `authenticated` in `psql`
is rejected; the definer function succeeds and stamps the right `on_behalf_of`;
a cross-org call through it fails.

**Files:** 1 migration, `lib/agent/audit.ts` (+ test), docs, types.

---

## Batch G — Four tools, and no fifth (one commit)

- [ ] **T25** `lib/agent/tools/` — `get_revenue_summary`, `list_invoices`,
      `search_documents` (auto-execute, read-only) and `draft_customer_email`
      (returns a draft object; no transport exists in the repo to send it).
      Each takes the request-scoped user client. Zod schema per tool, converted
      once to the Anthropic tool JSON schema — one definition, not two.
- [ ] **T26** `lib/agent/tools/index.ts` — the registry, plus a unit test that
      asserts the registry has **exactly four** entries. US-04 is a countable
      claim; a test is what keeps it one.
- [ ] **T27** Per-tool unit tests including the cross-org case: each tool called
      with Globex's JWT and an Acme `org_id`/`invoice_id` returns empty, not
      another tenant's row.

**Verification:** `bun test lib`; the four-tool assertion fails if a fifth is
added.

**Files:** 4 tool modules + registry + tests (≈6 files, at the batch size limit —
splitting them would ship a registry without its tools).

---

## Batch H — The loop (one commit)

- [ ] **T28** `lib/agent/loop.ts` — Anthropic tool-use loop: **max 6 steps, 30s
      wall-clock budget, token ceiling**, each bound enforced by the loop and
      each breach ending the turn with a stated reason rather than a truncated
      answer. Every step writes `llm_calls` via T23 under the request's single
      `correlation_id`.
- [ ] **T29** `lib/agent/prompt.ts` — the system prompt as a versioned constant,
      so Stage 6 can diff a prompt change against an eval result.
- [ ] **T30** `app/api/agent/chat/route.ts` — authenticated route, user JWT via
      `lib/supabase/server-client.ts`, `correlation_id` accepted or generated,
      one `audit_log` row per tool call with `actor_type='agent'` and
      `on_behalf_of=user_id`. No streaming (PRD out-of-scope).
- [ ] **T31** Unit tests against a stubbed Anthropic client: step cap reached,
      timeout reached, token ceiling reached — three distinct terminations, three
      distinct recorded reasons.

**Verification:** `task check`; a real question through `curl` with a signed-in
session returns an answer and leaves matching `llm_calls` + `audit_log` rows
sharing one `correlation_id`.

**Files:** `lib/agent/loop.ts`, `lib/agent/prompt.ts`, route, tests.

---

## Batch I — Citations, abstention, injection (one commit)

- [ ] **T32** `lib/agent/citations.ts` — deterministic check that every cited
      `chunk_id`/`invoice_id` was actually in the retrieved context for that
      turn; anything else marks the answer **unverified** rather than dropping the
      citation silently (US-02).
- [ ] **T33** Empty-retrieval abstention (US-06): retrieval returning nothing
      short-circuits to "I don't have data on that" **before** the model is asked
      to compose an answer. An instruction not to hallucinate is not a mechanism;
      not calling the model is.
- [ ] **T34** `tests/stage5-agent-safety.spec.ts` — three cases: (1) a question
      whose answer is not in the corpus abstains; (2) a fabricated citation is
      flagged unverified; (3) the poisoned document from T17 is retrieved, the
      agent attempts nothing harmful because no tool could, and the attempt is
      visible in `audit_log`.

**Verification:** `task e2e`; case 3 is the PRD's North Star and its assertion is
about the tool registry, not about the model's wording.

**Files:** `lib/agent/citations.ts` (+ test), loop wiring, 1 e2e spec.

---

### Checkpoint: agent (after Batch I)

- [ ] `task check` and `task e2e` green.
- [ ] Every US-01…US-06 acceptance criterion has a test naming it.
- [ ] Reviewer pass on Batches F–I before the UI is built on top.

---

## Batch J — The chat panel (one commit)

- [ ] **T35** `components/dashboard/copilot-panel.tsx` — the reserved third
      column in `app/dashboard/page.tsx` (its comment at line ~126 names this
      task). TanStack Query mutation against T30; renders citations as links into
      the existing `LineageDrillDown` selection context where the citation is an
      invoice; loading, empty, error and **unverified-answer** states all visible.
- [ ] **T36** Design tokens only — no hardcoded hex or px (`CLAUDE.md` Frontend).
      Load the `dataviz` skill only if a metric rendering appears; plain text
      answers do not need it.
- [ ] **T37** Wire into `app/dashboard/page.tsx`, replacing the reserved empty
      column and its Stage 5 comment.

**Verification:** the page renders signed in with the panel populated; no
`service_role` reference anywhere in the client bundle (the Stage 4 token grep,
re-run).

**Files:** 1 component, `app/dashboard/page.tsx`. A `*.stories.tsx` is **not**
required — this is a one-off page section, not a shared component
(`CLAUDE.md` Frontend).

---

## Batch K — Close-out (one commit)

- [ ] **T38** `tests/stage5-agent.spec.ts` — the browser flow: sign in, ask,
      see an answer with citations; as `bob@globex.test`, no Acme content is
      reachable through the panel. Fabricated rows cleaned up by a per-run tag,
      as `tests/stage4-dashboard.spec.ts` does, because Stage 3's reconciliation
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

- ~~Cost accounting in `llm_calls.cost_cents`~~ — closed in ADR 0009: a
  versioned price table in the repo, cost computed at write time, so a
  historical row keeps the price actually paid and a price change does not
  silently rewrite last month's numbers. The price table itself lands in
  Batch F.
- Which Anthropic model the agent runs on is still open, and it decides the
  price-table entry above and the token ceiling in Batch H. Pick it in Batch H
  against the latency the loop actually shows, not before.
