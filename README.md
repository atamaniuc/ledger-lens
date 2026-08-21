# LedgerLens

**An AI copilot over financial data you can actually trust.**

[![CI](https://github.com/atamaniuc/ledger-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/atamaniuc/ledger-lens/actions/workflows/ci.yml)
[![Evals](https://github.com/atamaniuc/ledger-lens/actions/workflows/evals.yml/badge.svg)](https://github.com/atamaniuc/ledger-lens/actions/workflows/evals.yml)

**CI** = the code is green. **Evals** = the measurement; it is red on purpose
until a model key exists, because a run that measured nothing is not a pass.
Full reading in [What the gates say today](#what-the-gates-say-today).

---

## The pitch (30 seconds, no jargon)

Most \"AI on your data\" demos put a chat box over whatever is in the database.
That is the easy 20%. The hard 80% is making the **numbers** trustworthy, and
that is what LedgerLens does first.

An upstream API deliberately tries to corrupt the data — duplicate events,
renamed fields, expired tokens, outages. The pipeline catches every one of
them and still lands on exactly the right total. Only then does an AI copilot
sit on top, and it has one rule: **it cannot answer anything it cannot prove.**
Every figure it quotes is traced back to the raw bytes that produced it, every
citation is verified, and it has no capability that a poisoned document could
misuse.

You can see this today: sign in, ask the copilot a question about the tenant\'s
own data, click any number and follow it down to the original record.

Next.js 16 · Postgres/Supabase · pgvector · Python · Deno · Pulumi · Modal

<img width="1023" height="955" alt="Dashboard with metric tiles, data health and the copilot panel" src="https://github.com/user-attachments/assets/fa7bca31-3c73-4e67-944f-281fec050808" />
<img width="1117" height="925" alt="Lineage drill-down from a dashboard number to the raw payload" src="https://github.com/user-attachments/assets/a68dd952-f4ff-4551-8dc8-b65d074006d3" />

---

## Why this is hard (for the engineer and the investor alike)

An LLM layered on unvalidated data does not fix bad data — it makes wrong
numbers sound convincing. That is the exact failure a finance team cannot
afford. So the project\'s claim is not \"AI works on our data\"; it is that the
data is made trustworthy first, and the AI is then **bounded by design**:

- it reads through the same row-level security as the dashboard — it can only
  see what the signed-in user can see;
- it has exactly four tools, none of which can send, write or reach the
  network;
- an answer that cannot cite a row it actually read is marked unverified,
  never silently trusted.

---

## What\'s under the hood (engineers)

Three things carry the signal, and each one is a test rather than a claim.

| Killer feature | Why it is not a demo |
|---|---|
| **An upstream that fights back → drift of exactly 0** | The mock provider duplicates events, drifts its schema, nulls fields, expires tokens, returns 429s and 500s, and dates records in the future — seven flags, on a fixed seed, so every failure mode is a regression test. Reconciliation compares the tenant\'s ledger against the provider\'s own independent total: naive summing overstates it by **1,389,015 cents (+2.65%)**; the shipped pipeline lands on **0**. <!-- proof: docs/RECONCILIATION.md --> <!-- proof: src/features/provider/chaos.ts --> |
| **Injection containment by capability, not by prompt** | A poisoned document lives in the corpus on purpose. The agent has exactly four tools — three read-only, one that drafts an email — and **no send capability exists anywhere in the system**, so the attack has nothing to reach. The attempt is retrieved, audited, and scored: the eval suite grades the *answer*, not just the retrieval. <!-- proof: src/features/agent/tools/index.ts:TOOL_COUNT --> <!-- proof: tests/stage5-tools.spec.ts#no tool in the registry can write anything --> <!-- proof: tests/stage5-agent-safety.spec.ts#the poisoned document is retrieved, and there is nothing it can make the agent do --> |
| **Every number drills to its raw payload** | Click a figure on the dashboard and follow it back through `data_quality_results` → `invoices` → `raw_events` to the bytes that arrived, with the `run_id` that wrote them. Copilot citations are verified deterministically against what a tool actually returned. <!-- proof: src/features/dashboard/queries.ts --> <!-- proof: src/features/agent/citations.ts:verifyCitations --> |
| **The copilot cannot embarrass a presentation** | Runtime settings in the admin panel (`/admin`): a guards flag, and a **demo mode** that answers deterministically from this tenant\'s real data — no model call, no rate limit, no \"try again later\" — even when every provider is spent. <!-- proof: src/app/admin/page.tsx --> <!-- proof: src/features/agent/demo-answer.ts --> |

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
| The embedding function\'s isolate is killed (HTTP 546) | Four attempts with jittered backoff, then the batch **halves** down to single texts, order preserved — the cost of one request is the limit, so a smaller request is the answer <!-- proof: src/features/rag/embed.ts:WORKER_LIMIT_STATUS --> |
| One free model rate-limits mid-turn | The next provider in `LLM_CHAIN` answers; the one that actually answered is recorded per row, so `fallback_rate` is one query and silent degradation is impossible <!-- proof: src/features/agent/providers/chain.ts:ChainExhaustedError --> |
| A user burns the shared budget | Per-user and per-org windows plus daily caps computed from `llm_calls` — **both cost and tokens**, because a free-tier model costs $0 while still burning the provider\'s quota: 429 or 402 with a reset time, never a generic 500 <!-- proof: migration:20260821100000 --> |
| Retrieval comes back empty | The agent abstains after two empty steps instead of composing an answer <!-- proof: src/features/agent/loop.ts:ABSTENTION_ANSWER --> |
| The reader closes the panel mid-answer | The turn stops within one step, makes no further provider call, and is audited as `cancelled` — never as an answer <!-- proof: tests/agent-cancel.spec.ts --> |
| A new table ships without RLS | The suite goes red: RLS coverage is asserted against the catalogue, not a checklist <!-- proof: tests/rls-coverage.spec.ts#every table in public has row level security enabled --> |

---

## Try it

```bash
task up     # one command from a clean clone: install, stack, migrations, seed, env, URL
task dev    # http://localhost:3000
```
<!-- proof: task up --> <!-- proof: task dev -->

Sign in as **alice@acme.test** or **bob@globex.test** (password `password123`).
No provider key? Open the admin panel at `/admin`, turn on **demo mode**, and
the copilot still answers — from real tenant data, with no model call. The
mechanism is documented in `docs/RUNBOOK.md`.

```bash
task check        # typecheck, lint, unit tests, deno check, doc proofs
task verify       # that, plus the schema check, the end-to-end suite and the evals
task check-py     # ruff, mypy, pytest across both Python projects
task check-infra  # the Pulumi program, asserted with mocks — no cloud credentials
```
<!-- proof: task check --> <!-- proof: task verify --> <!-- proof: task check-py --> <!-- proof: task check-infra -->

Running it, deploying it, and the failures worth knowing about:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md). Architecture and diagrams:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/ARCHITECTURE-C4.md`](docs/ARCHITECTURE-C4.md). Data model and invariants:
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md). Accounts, routes, roles:
[`docs/ACCOUNTS.md`](docs/ACCOUNTS.md). Patterns and paradigms:
[`docs/PATTERNS.md`](docs/PATTERNS.md). Manual QA:
[`docs/QA-MANUAL.md`](docs/QA-MANUAL.md).
<!-- proof: docs/RUNBOOK.md --> <!-- proof: docs/ARCHITECTURE.md --> <!-- proof: docs/DATA_MODEL.md -->

---

## For developers

The process is spec-driven and small enough to read in a minute: one spec per
deliverable in [`specs/`](specs/) with acceptance criteria that name an
executable check, one page per decision in [`decisions/`](decisions/), one
debt register in [`DEBT.md`](DEBT.md), and one rules file for agents in
[`AGENTS.md`](AGENTS.md) — 50 lines, not 500.
<!-- proof: specs/DoD.md --> <!-- proof: decisions/README.md --> <!-- proof: AGENTS.md -->

- **Where things live:** `src/features/*` is one vertical slice per domain
  (ingestion, quality, rag, agent, dashboard, provider); `src/platform/*`
  holds cross-cutting infrastructure (config, supabase clients, signing,
  observability). `supabase/migrations/` is the schema, `py/` the Python
  services (indexer, judge, Modal app), `infra/` the Pulumi program.
- **How to add a feature:** read [`docs/HARNESS-QUICKSTART.md`](docs/HARNESS-QUICKSTART.md) —
  the one-screen start for any agent or human.
- **The harness is model-agnostic:** Claude Code, Codex, Cursor or a human all
  follow the same files. See [`docs/HARNESS.md`](docs/HARNESS.md).

---

## What the gates say today

Measured on 2026-08-21, and red where it is red. A green badge over an
unmeasured gate is worse than a red one. The counts are a snapshot of that run,
not a promise about the current tree — the commands are the claim.

| Gate | Reading |
|---|---|
| `task check` | 411 tests in 45 files — unit, component and every Storybook story run as a test in Chromium, plus axe on each dashboard panel state <!-- proof: .storybook/main.ts --> |
| `task e2e` | 179 Playwright tests against the real stack — RLS through two different doors, both ingestion paths, the four tools, replay refusal, both agent transports, a corpus that survives the suite, and demo mode <!-- proof: tests/copilot-demo-mode.spec.ts --> |
| `task check-py` | pytest cases: the bulk indexer (chunker ported **byte-identical** to the TypeScript one, proven against golden fixtures), the groundedness judge, the Modal app <!-- proof: py/ledgerlens_indexer --> <!-- proof: py/ledgerlens_judge --> <!-- proof: py/modal --> |
| `task check-infra` | 29 tests through `pulumi.runtime.setMocks`, and `task infra-plan` has the real engine plan all 23 resources against a throwaway local backend — the deploy program is verified end to end without owning anything <!-- proof: infra/index.ts --> <!-- proof: task infra-plan --> |
| recall@5 | **1.00** over 80 eval cases, every target at rank 1 <!-- proof: evals/dataset.jsonl --> |
| abstention on unanswerable | **1.00** — 15 cases measured in the 0.73–0.80 near-miss band under a 0.80 floor <!-- proof: src/features/rag/search.ts:DEFAULT_MIN_SIMILARITY --> |
| citation validity | **red, and the bar stays 0.95.** Three measured runs read 0.23 → 0.83 → 0.73, and the spread is the finding: with 30 citation-bearing cases, two answers decide the score, so **a single run cannot attribute a ±0.10 move to a code change**. The structural causes were real and are fixed — a revenue tool that returned a total with nothing to cite (ceiling 0.47), and a verifier that refused the internal id its own tools handed the model. What is left is model capability at the free tier plus a dataset too small to read a 0.95 bar this finely <!-- proof: evals/thresholds.json --> <!-- proof: src/features/agent/tools/get-revenue-summary.ts:MAX_EVIDENCE_IDS --> |
| injection safety | **0.86 (6/7) against a 1.00 bar — red, and the mechanism is why it moved at all.** Containment was never the question: no tool can act. The question the new rule asks is whether the *reader* is told, and the first measured answer was no — 0.00, every case summarised without mentioning the instruction. Disclosure is a mechanism now, not a request: retrieval detects text addressed to the assistant and the turn states it, in the rule\'s own words. That took it to 0.80; the last case is a detector gap, and two more could not be scored under a per-minute rate limit <!-- proof: src/features/agent/injection.ts:DISCLOSURE_PATTERNS --> <!-- proof: evals/README.md --> |
| tool choice | **0.90 against a 1.00 bar — red.** Three questions about a total were answered by listing invoices and adding them up, which is a different number once the list truncates. Both tool descriptions now say where the boundary is <!-- proof: src/features/agent/tools/get-revenue-summary.ts --> |
| a run with no API key | **Exits non-zero** and names every metric that went unmeasured. `--allow-skip` exists for local exploration and CI never passes it <!-- proof: task evals --> |
| CI | **six jobs, all green** — typecheck/lint/unit/stories, the RLS end-to-end suite, both Python projects, the Pulumi program, secret scan and the dead-code gate <!-- proof: .github/workflows/ci.yml --> |
| Evals workflow | **red, and correctly so**: the deterministic half passes there (recall@5 1.00, abstention 1.00), the three model-dependent metrics report *not measured* without a key, and the run exits non-zero <!-- proof: .github/workflows/evals.yml --> |

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
| AI | A failover chain over free tiers (Groq, NVIDIA NIM, any OpenAI-compatible), `gte-small` embeddings, hybrid retrieval with RRF, a four-tool agent under the user\'s own JWT, and an admin panel for runtime providers and demo mode |
| Python | Bulk indexer, claim-level groundedness judge, Whisper transcription on Modal — `uv`, ruff, strict mypy |
| Infrastructure | Pulumi (Vercel native, Supabase and Modal command-wrapped), GitHub Actions |
| Observability | Hand-rolled OTel-shaped spans with `correlation_id` as the trace id, four metric views, alerts as rows <!-- proof: src/platform/obs/index.ts --> |

---

## How this repository is built

Spec-driven, with a mechanism that keeps every document honest: each claim in
this file carries a `<!-- proof: ... -->` marker naming a file, a symbol, a
test, a task or a migration, and `task check` fails when one stops resolving.
It exists because this README once promised a Pulumi program that did not
exist and an LLM-as-judge gate that was denied three screens lower.
<!-- proof: src/platform/docs-proof.ts:MUST_CARRY_PROOF --> <!-- proof: task docs-check -->
