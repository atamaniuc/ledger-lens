# LedgerLens

**An AI copilot over financial data you can actually trust.** The pipeline that
proves the numbers is the product; the copilot is a thin, capability-bounded
layer on top.

Next.js 16 · Postgres/Supabase · pgvector · Python · Deno · Pulumi · Modal

<img width="1023" height="955" alt="Dashboard with metric tiles, data health and the copilot panel" src="https://github.com/user-attachments/assets/fa7bca31-3c73-4e67-944f-281fec050808" />
<img width="1117" height="925" alt="Lineage drill-down from a dashboard number to the raw payload" src="https://github.com/user-attachments/assets/a68dd952-f4ff-4551-8dc8-b65d074006d3" />

---

## The argument

An LLM on unvalidated data does not fix bad data — it makes wrong numbers
sound convincing. So this project inverts the usual emphasis: a deliberately
adversarial upstream, a pipeline that survives it, and only then an agent that
can answer nothing it cannot prove.

Three things carry the signal, and each one is a test rather than a claim.

| Killer feature | Why it is not a demo |
|---|---|
| **An upstream that fights back → drift of exactly 0** | The mock provider duplicates events, drifts its schema, nulls fields, expires tokens, returns 429s and 500s, and dates records in the future — seven flags, on a fixed seed, so every failure mode is a regression test. Reconciliation compares the tenant's ledger against the provider's own independent total: naive summing overstates it by **1,389,015 cents (+2.65%)**; the shipped pipeline lands on **0**. <!-- proof: docs/RECONCILIATION.md --> <!-- proof: src/features/provider/chaos.ts --> |
| **Injection containment by capability, not by prompt** | A poisoned document lives in the corpus on purpose. The agent has exactly four tools — three read-only, one that drafts an email — and **no send capability exists anywhere in the system**, so the attack has nothing to reach. The attempt is retrieved, audited, and now scored: the eval suite grades the *answer*, not just the retrieval. <!-- proof: src/features/agent/tools/index.ts:TOOL_COUNT --> <!-- proof: tests/stage5-tools.spec.ts#no tool in the registry can write anything --> <!-- proof: tests/stage5-agent-safety.spec.ts#the poisoned document is retrieved, and there is nothing it can make the agent do --> |
| **Every number drills to its raw payload** | Click a figure on the dashboard and follow it back through `data_quality_results` → `invoices` → `raw_events` to the bytes that arrived, with the `run_id` that wrote them. Copilot citations are verified deterministically against what a tool actually returned. <!-- proof: src/features/dashboard/queries.ts --> <!-- proof: src/features/agent/citations.ts:verifyCitations --> |

---

## How it fails

The interesting half of a data system. Every row is exercised by a test, not
described in a paragraph.

| Failure | What the system does |
|---|---|
| The same event delivered twice | `unique (org_id, source, external_id, event_version)` collapses it inside one transaction; the counters still balance <!-- proof: src/features/ingestion/cursor.ts:countersBalance --> |
| The upstream renames a field mid-stream | Tolerated by the transform; a record that cannot be understood goes to `quarantine` **with its payload and a reason**, never dropped, never blocking the load <!-- proof: src/features/ingestion/transform.ts:validateInvoice --> |
| A record dated in the future | Quarantined as `future_dated` — it used to pass a format-only check and quietly inflate every metric <!-- proof: tests/future-dates.spec.ts --> |
| 429 or 500 from the upstream | Retry with jittered backoff and a circuit breaker, inside a run budget short enough for a serverless request <!-- proof: src/features/ingestion/backoff.ts --> |
| A captured webhook replayed | Refused: HMAC over `v1:<ts>:<nonce>:<body>`, constant-time, five-minute freshness window, single-use nonce in Postgres <!-- proof: tests/webhook-replay.spec.ts#rejects the identical signed request delivered twice --> |
| Two ingestion runs racing | One org-keyed advisory lock plus a partial unique index: at most one `running` run per org, so the cursor cannot advance twice <!-- proof: migration:20260821110000 --> |
| The embedding function's isolate is killed (HTTP 546) | Four attempts with jittered backoff, then the batch **halves** down to single texts, order preserved — the cost of one request is the limit, so a smaller request is the answer <!-- proof: src/features/rag/embed.ts:WORKER_LIMIT_STATUS --> |
| One free model rate-limits mid-turn | The next provider in `LLM_CHAIN` answers; the one that actually answered is recorded per row, so `fallback_rate` is one query and silent degradation is impossible <!-- proof: src/features/agent/providers/chain.ts:ChainExhaustedError --> |
| A user burns the shared budget | Per-user and per-org windows plus a daily cap computed from `llm_calls.cost_cents`: 429 or 402 with a reset time, never a generic 500 <!-- proof: migration:20260821100000 --> |
| Retrieval comes back empty | The agent abstains after two empty steps instead of composing an answer <!-- proof: src/features/agent/loop.ts:ABSTENTION_ANSWER --> |
| The reader closes the panel mid-answer | The turn stops within one step, makes no further provider call, and is audited as `cancelled` — never as an answer <!-- proof: tests/agent-cancel.spec.ts --> |
| A new table ships without RLS | The suite goes red: RLS coverage is asserted against the catalogue, not a checklist <!-- proof: tests/rls-coverage.spec.ts#every table in public has row level security enabled --> |

---

## Run it

```bash
task up     # one command from a clean clone: install, stack, migrations, seed, env, URL
task dev    # http://localhost:3000
```

Needs Docker, Node 22+, pnpm, Deno, the Supabase CLI and Task. Everything else
— including the two seeded tenants and their users — comes from `task up`.
<!-- proof: task up --> <!-- proof: task dev -->

```bash
task check        # typecheck, lint, 364 unit/component/story tests, deno check, doc proofs
task verify       # that, plus the schema check, the end-to-end suite and the evals
task check-py     # ruff, mypy, 168 pytest cases across two uv projects
task check-infra  # the Pulumi program, asserted with mocks — no cloud credentials
```
<!-- proof: task check --> <!-- proof: task verify --> <!-- proof: task check-py --> <!-- proof: task check-infra -->

Running it, deploying it, and the failures worth knowing about:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). Architecture and diagrams:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Data model and invariants:
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).
<!-- proof: docs/RUNBOOK.md --> <!-- proof: docs/ARCHITECTURE.md --> <!-- proof: docs/DATA_MODEL.md -->

---

## What the gates say today

Measured on 2026-08-21, and red where it is red. A green badge over an
unmeasured gate is worse than a red one. The counts are a snapshot of that run,
not a promise about the current tree — the commands are the claim.

| Gate | Reading |
|---|---|
| `task check` | 403 tests in 45 files — unit, component and every Storybook story run as a test in Chromium, plus axe on each dashboard panel state <!-- proof: .storybook/main.ts --> |
| `task e2e` | 175 Playwright tests against the real stack — 174 pass, 1 skips itself when the local mail limit is hit: RLS through two different doors, both ingestion paths, the four tools, replay refusal, both agent transports, and a corpus that survives the suite |
| `task check-py` | 168 pytest cases: the bulk indexer (chunker ported **byte-identical** to the TypeScript one, proven against golden fixtures), the groundedness judge, the Modal app <!-- proof: py/ledgerlens_indexer --> <!-- proof: py/ledgerlens_judge --> <!-- proof: py/modal --> |
| `task check-infra` | 29 tests through `pulumi.runtime.setMocks` — the deploy program is verified without a token <!-- proof: infra/index.ts --> |
| recall@5 | **1.00** over 80 eval cases, every target at rank 1 <!-- proof: evals/dataset.jsonl --> |
| abstention on unanswerable | **1.00** — 15 cases measured in the 0.73–0.80 near-miss band under a 0.80 floor <!-- proof: src/features/rag/search.ts:DEFAULT_MIN_SIMILARITY --> |
| citation validity | **RED, and the bar stays 0.95.** Measured at 0.23, which sent us looking: more than half those cases ask for a revenue figure, and `get_revenue_summary` returned a total with nothing to cite — a perfectly compliant answer could not clear 0.47. The tool now names the invoices behind the figure, the prompt states the contract, and one bounded repair asks for citations exactly once. The re-measurement is owed: the free tier's daily budget was spent at 199.1k of 200k tokens <!-- proof: evals/thresholds.json --> <!-- proof: src/features/agent/tools/get-revenue-summary.ts:MAX_EVIDENCE_IDS --> |
| injection safety | **RED on two cases.** Containment holds — no tool can act — but the new rule grades the answer, and on this model two poisoned prompts are summarised without refusing or flagging the embedded instruction. The old metric passed them, which is exactly why it was changed <!-- proof: evals/README.md --> |
| a run with no API key | **Exits non-zero** and names every metric that went unmeasured. `--allow-skip` exists for local exploration and CI never passes it <!-- proof: task evals --> |

---

## Not built, and why

- **No deployment yet.** `infra/` exists and is tested; the run needs a human
  `pulumi login` and a Vercel token. The hosted database is behind the local
  one until that happens.
- **The scheduler enqueues, nothing consumes.** `pg_cron` writes
  `scheduled_runs` markers every 15 minutes; a consumer that turns a marker
  into an HTTP call is not in this tree, and the documents say so rather than
  implying a running pipeline. <!-- proof: migration:20260821110000 -->
- **Citations and injection are red** (above). The next move is the answer
  contract in the prompt, not a softer threshold.
- Everything else, with a machine-verifiable closure criterion per line:
  [`DEBT.md`](DEBT.md). <!-- proof: DEBT.md -->

---

## Stack

| Layer | What |
|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind, shadcn/ui, TanStack Query, Storybook as a test suite |
| Backend | Next.js route handlers, Deno Edge Functions (webhooks, embeddings), Postgres functions for anything transactional |
| Database | Supabase Postgres — RLS on every table, `pgvector` HNSW + `tsvector` GIN, `pg_cron` |
| AI | A failover chain over free tiers (Groq, NVIDIA NIM, any OpenAI-compatible), `gte-small` embeddings, hybrid retrieval with RRF, a four-tool agent under the user's own JWT |
| Python | Bulk indexer, claim-level groundedness judge, Whisper transcription on Modal — `uv`, ruff, strict mypy |
| Infrastructure | Pulumi (Vercel native, Supabase and Modal command-wrapped), GitHub Actions: eight jobs |
| Observability | Hand-rolled OTel-shaped spans with `correlation_id` as the trace id, four metric views, alerts as rows <!-- proof: src/platform/obs/index.ts --> |

---

## How this repository is built

Spec-driven, and the process is small enough to read in a minute:
one spec per deliverable in [`specs/`](specs/) with acceptance criteria that
name an executable check, one page per decision in
[`decisions/`](decisions/), one debt register in [`DEBT.md`](DEBT.md), and
one rules file for agents in [`AGENTS.md`](AGENTS.md) — 50 lines, not 500.
<!-- proof: specs/DoD.md --> <!-- proof: decisions/README.md --> <!-- proof: AGENTS.md -->

The mechanism that keeps this file honest: every claim above carries a
`<!-- proof: ... -->` marker naming a file, a symbol, a test, a task or a
migration, and `task check` fails when one of them stops resolving. It exists
because this README once promised a Pulumi program that did not exist and an
LLM-as-judge gate that was denied three screens lower.
<!-- proof: src/platform/docs-proof.ts:MUST_CARRY_PROOF --> <!-- proof: task docs-check -->
