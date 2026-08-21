# Archive — Stages 1–6 (what shipped)

Condensed from `PROGRESS.md` and `.claude/tasks/*` (both deleted). The numbers
are real; the essays are not. Current truth lives in `DEBT.md` and the lane
specs; this file only records what shipped and what it cost.

## Stage table

| Stage | State | What it produced |
|---|---|---|
| 0 — PRD | done | 8 PRD entries (now `specs/product.md`) |
| 1 — Mock Provider | done | `/invoices` + `/summary`, 7 chaos flags, all runtime-verified |
| 2 — Ingestion & Transform | done | polling route + webhook Edge Function, atomic single-record ingest (ADR 0003, 0004) |
| 3 — Quality & Reconciliation | done | 4 checks per `run_id` in one Postgres function (ADR 0005) |
| — Local dev loop | done | containerised toolchain, `task` surface, generated types (ADR 0006) |
| 4 — Dashboard | done | auth, tiles, freshness badge, Data Health, lineage, Realtime (ADR 0007) |
| 5 — RAG & Agent | done | hybrid retrieval, 4-tool agent under user JWT, copilot panel (ADR 0008, 0009) |
| 6 — Evals + CI gate | done (POC) | 20-case dataset, versioned thresholds, `task evals`, one GitHub Actions workflow |
| 7 — Stretch | not planned | consciously skipped; core loop is the project |

## What runs today
Full stack on one machine: local Supabase in Docker (two tenants, two auth
users), the app against the same Linux/Bun environment that ships. **94
Playwright tests** from an empty database, **146 unit tests**. Corpus: **366
chunks** (Acme 4 document + 180 invoice; Globex 2 document + 180 invoice);
re-index is a no-op (0 inserted / 0 updated / 0 deleted / 0 embeddings).
RLS is asserted two ways: impersonating `authenticated` in Postgres and
signing in through GoTrue for real.

## Baselines (measured)

- **Reconciliation drift: exactly 0.** Provider independent total 52,417,661 =
  invoiced 47,942,632 + quarantined-but-recoverable 4,475,029. Before/after
  pair in `docs/RECONCILIATION.md`; comparing against written
  invoices alone reports −8.54% on a healthy pipeline, which is why that
  framing was rejected (ADR 0005).
- **`get_advisors` 2026-08-18 (hosted):** security clean, performance 10 INFO
  `unused_index`. **2026-08-19 after Stage 5:** security clean, 11 INFO
  `unused_index` — same class, same tables; Stage 5 migrations are local only
  (hosted stops at `20260819120000`). `supabase db lint --level warning` on
  the local stack: no schema errors.
- **Eval set 2026-08-19, `groq/openai/gpt-oss-20b`:** before uncited answers
  counted as unverified — all five metrics 1.00 (wrong green). After: recall@5
  **1.00** (8/8), abstention **1.00** (5/5), injection **1.00** (2/2), tool
  choice **1.00** (4/4), **citation validity 0.50 (2/4) — FAIL**. The two
  misses: one answer cited nothing; one wrote `[invoice:open]` — a status as
  an id. Three cases unscored (Groq free daily ceiling); unscored exits
  non-zero. All metrics 1.00 on a later run with every case scored.
- **Retrieval recall@5 = 1.00 (5/5), every target at rank 1**, measured in
  Batch E before the agent existed, so ADR 0008's model choice could be
  reversed cheaply. Five hand-written queries is a floor, not a measurement.
- **Relevance floor: measured 0.78** (relevant 0.820–0.897, unrelated
  0.701–0.757, `gte-small`, migration `20260819200000` carries the numbers).
  Raised to **0.80** after eval case `una-05` ("office wifi password") scored
  0.791 against the 0.78 floor and abstention went red. The margin — 0.791
  unrelated vs 0.803 weakest relevant — is why the dataset must grow to ≥60.
- **Embed batch cap: 8** — the Edge Runtime trips HTTP 546 `WORKER_LIMIT` at
  16; 8 embeds ≈ 1s, full index ≈ 45s, warm re-run ≈ 1.5s.

## Stage records (condensed)

### Stage 4 — Dashboard (`.claude/tasks/stage-4-dashboard.md`)
Batches A–F, one commit each. Access foundation: `@supabase/ssr`,
`proxy.ts` (not `middleware.ts` — Next 16.3.1 deprecates it), lint rule
forbidding the service client outside `app/api/**` +
`supabase/functions/**`. Realtime: publication holds exactly
`pipeline_runs` + `data_quality_results`, INSERT/UPDATE only, never `*`.
Read contracts: freshness from `max(raw_events.ingested_at)`, invoice cursor
`(issued_at desc, id desc)`, lineage payload. Design: shadcn/Storybook
**dropped deliberately** (T9) — four states asserted in e2e instead; token
contract + a real design-token gate. Surfaces: tiles, badge (never defaults
to fresh), Data Health (missing ≠ failing), invoices table, lineage drawer,
live runs. E2E: 9 cases incl. cross-tenant absence from the DOM.
**Costs:** GoTrue silently substitutes `site_url` for an out-of-allowlist
`emailRedirectTo`; new route segments need a dev restart; the Realtime bridge
re-subscribed per refresh because `correlation_id` was minted per render.

### Stage 5 — RAG & Agent (`.claude/tasks/stage-5-rag-agent.md`)
Batches A–K. Decisions (ADR 0008/0009): embeddings in the Edge Runtime with
`gte-small` (384-d, no key), hybrid search as one `SECURITY INVOKER`
function, agent under the user's JWT, audit rows via `SECURITY DEFINER`
writers. Corpus: `documents`/`chunks` with two nullable FKs +
`num_nonnulls(...) = 1` + generated `source_kind`; HNSW + GIN. Embedding
function: shared-secret, batch cap 8, rejects empty arrays. Indexer:
deterministic chunking, content-hash skip, upsert on plain unique constraints
(partial ones are not inferable by PostgREST `ON CONFLICT`). Search:
RRF (k=60) fusion, vector floor + lexical half unfiltered. Agent: max 6
steps / 30s / token ceiling, each bound ending the turn with a stated reason;
exactly 4 tools + registry-count test; failed audit write fails the turn.
Safety: empty-retrieval abstention (made reachable by the relevance floor),
deterministic citation verification, poisoned-document injection test — the
attempt fails on the registry and lands in `audit_log`. Panel: 6 states,
unverified banner, lineage integration.
**Costs:** the chunker's regex silently dropped text (now a character
scanner); a correct citation came back unverified (uuid vs `external_id`);
abstention fired on the *first* empty search (`EMPTY_STEPS_BEFORE_ABSTAINING`
= 2 now); the successful-tool audit write sat inside the tool's `try` and
mislabelled success as `tool_call_failed`; Groq's server-side schema
validation rejected explicit `null` optionals (all `.nullish()`) and a
published `max` (types in the schema, bounds in the tool body); the 30s
budget did not bound the model call itself; `correlation_id` was taken from
the body unvalidated; multi-org accounts are refused with 409.
**Not proven:** no `ANTHROPIC_API_KEY` in the build environment, so no turn
ran against a real model; the route spec asserts the 503 branch. First job
with a key: the end-to-end model pass. (Now: Groq is configured, NVIDIA NIM
never called — no key.)
