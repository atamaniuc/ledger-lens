# LedgerLens — Product Requirements

## Mock Provider

**Problem:**
Without an upstream system that actually misbehaves, "idempotent ingestion" and "handles schema drift" are just vocabulary — there's nothing to demonstrate and nothing to test against. Этап 1 in `07_Пет_проект.md` builds the adversary the rest of the pipeline has to survive.

**User:**
Downstream: the ingestion job (Этап 2) and its tests. Narratively: stands in for the real third-party accounting/payments API the JD's integrations work would target.

**Success criteria:**
- `GET /api/mock-provider/invoices` returns cursor-paginated invoice pages.
- Seven chaos flags, independently toggleable (env var or query param), each verifiably triggers its failure:
  - `duplicates` — a measurable ~5% repeat rate across a run.
  - `schemaDrift` — `amount` flips from `number` to a numeric string after a configured date/cursor point.
  - `nullFields` — `customer` is `null` on some fraction of records.
  - `rateLimit` — every 10th request returns `429` with a `Retry-After` header.
  - `serverError` — every 25th request returns `500`.
  - `expiredToken` — `401` after N requests on the same token.
  - `futureDates` — some `issued_at` values are in the future.
- Deterministic under a fixed seed — same seed reproduces the same failure sequence, so it's usable as a regression fixture, not just a demo toy.
- `GET /api/mock-provider/summary` exists and returns the provider's own aggregate total, independent of `/invoices` — this is what Этап 3's reconciliation check compares against.

**Non-goals:**
- Real persistence — in-memory/seeded dataset is enough, no need for its own database.
- Auth on the mock endpoint beyond the `expiredToken` chaos flag itself.
- Modeling more than one upstream provider.

## Ingestion & Transform

**Problem:**
Raw data from an adversarial provider has to become trustworthy rows without losing information or double-counting — and it has to survive being run twice, run out of order, or interrupted mid-page. This is the JD's "reliable data pipelines with validation" requirement made concrete.

**User:**
The transform stage (Этап 3 quality checks) and the dashboard (Этап 4) both depend on `invoices`/`quarantine` being trustworthy. Also stands in for whoever operates the pipeline day-to-day (would be a data/platform engineer in a real org).

**Success criteria:**
- Cursor stored in `pipeline_runs.cursor_to`; a re-run picks up from the last successful cursor, not from scratch.
- Retry logic: exponential backoff with jitter, honors the mock provider's `Retry-After` header, circuit breaker opens after 5 consecutive failures and records the reason on `pipeline_runs.error`.
- Idempotency: running ingestion twice against an identical mock-provider output yields zero net new rows in `raw_events` (`unique(source, external_id, event_version)` + `ON CONFLICT DO NOTHING` holds).
- Zod schema validation on transform: valid records land in `invoices`; invalid land in `quarantine` with a populated `reason` and the original payload preserved via `raw_event_id` — nothing is silently dropped.
- `pipeline_runs` accurately counts `rows_read` / `rows_written` / `rows_quarantined` per run.
- Webhook path (Deno Edge Function, `supabase functions deploy provider-webhook`) accepts a pushed event and reuses the same transform code and the same idempotency guarantee as the polling path — this is what makes "event-driven" real rather than just a queue.

**Non-goals:**
- Exactly-once delivery guarantees beyond idempotent upsert (at-least-once + dedup is the actual contract).
- A generic multi-provider adapter abstraction — one provider is enough for this project's scope.

## Data Quality & Reconciliation

**Problem:**
A pipeline that ingests without checking itself is exactly the "AI on top of bad data" trap the whole project exists to avoid. This stage is the project's actual differentiator — the thing that turns "I built a pipeline" into "I built a pipeline that knows when it's lying to you."

**User:**
The dashboard's Data Health panel (Этап 4) and the README's before/after artifact (the project's single strongest interview talking point) both depend on this stage's output.

**Success criteria:**
- Four checks run every pipeline run and write to `data_quality_results`:
  - **Freshness** — `now() - max(ingested_at) < 2 hours`.
  - **Volume** — row count within ±50% of the trailing 7-day average.
  - **Uniqueness** — no duplicates on `(org_id, external_id)`.
  - **Reconciliation** — our summed `amount_cents` matches `/api/mock-provider/summary` within a defined tolerance (target: exact match once idempotency is applied).
- A reproducible before/after artifact: with the `duplicates` chaos flag on and idempotency not yet applied, reconciliation shows a measurable overstatement (recorded as a real percentage in the README); after the idempotency fix in the Ingestion stage, drift is 0. This pairing is mandatory — it's the project's centerpiece.
- Each check's `status` (`pass`/`warn`/`fail`) is queryable per `run_id`, not just as a global flag — this is what powers per-run drill-down in the dashboard.

**Non-goals:**
- Automated external alerting/paging (email, Slack, PagerDuty) — a dashboard badge is the v1 notification surface.
- Configurable thresholds via UI — hardcoded constants are fine for this scope.

## Dashboard

**Problem:**
The pipeline and quality checks are invisible unless something surfaces them to a human — and per the JD, that surface has to demonstrate real frontend chops (Next.js/TS/Tailwind/TanStack Query/shadcn), auth, and real-time updates, not just a data table.

**User:**
The in-fiction investment firm's ops team, checking whether this month's numbers can be trusted before closing the books. Also the interviewer, since this is the screen they'll actually look at.

**Success criteria:**
- Supabase Auth (magic link) gates the dashboard; `memberships.role` determines which org's data is visible — verified by the RLS non-owner test in Definition of Done.
- Revenue/invoices/average-invoice tiles render from `invoices`.
- Freshness badge changes state (fresh/stale) crossing the 2-hour threshold — testable by manipulating `ingested_at` in a seeded run.
- Data Health panel shows all 4 checks from the Data Quality stage with their latest pass/warn/fail status.
- Invoices table with cursor pagination.
- Lineage drill-down: clicking a number shows the contributing `raw_events`, `run_id`, source, and timestamp, down to the raw payload.
- Realtime: a new `pipeline_runs` row appears in the UI without a manual refresh (Supabase Realtime subscription) — verifiable with two concurrent sessions.
- Chat panel round-trips at least one query to the agent (depends on the RAG & Agent stage) and renders an answer with visible citations.
- New components ship with a co-located `*.stories.tsx` per CLAUDE.md's Frontend rules (default/loading/empty/error states).

**Non-goals:**
- Full visual polish/animation — Tailwind + shadcn, three components, no custom motion work (explicitly not where interview conversation-per-hour is highest).
- Mobile-responsive layout or i18n.

## RAG & Agent

**Problem:**
This is where the JD's core anxiety lives: an AI feature that can act (not just answer) has to be safe by construction, not by a prompt asking it to behave. "I trust the model" is not an acceptable design; "the model has no tool capable of the bad outcome" is.

**User:**
The dashboard's chat panel (consumer of this stage) and the interviewer evaluating the JD's "safe agentic workflows, scoped tools, evals" requirements directly.

**Success criteria:**
- Hybrid retrieval (vector + full-text, combined via Reciprocal Rank Fusion) returns sensible top-5 results for a fixed evaluation query set — verified quantitatively in the Evals stage, not just eyeballed.
- Exactly 4 tools: `get_revenue_summary`, `list_invoices`, `search_documents` (all read, auto-execute), and `draft_customer_email` (draft only — no send capability exists anywhere in the system, so the one write-adjacent tool cannot cause real-world side effects even in principle).
- Every tool call executes under the calling user's JWT, so Postgres RLS applies to the agent exactly as it applies to the dashboard — verified by a test: a user from org A cannot retrieve org B's chunks or invoices through the agent, even indirectly.
- Responses must cite `chunk_id`/`invoice_id`; a deterministic check confirms cited ids were actually present in the retrieved context, flagging the response as unverified otherwise.
- Max 6 tool-call steps, 30s timeout, token ceiling enforced.
- A poisoned document (prompt-injection payload) lives in the corpus; the agent must be unable to cause harm because no tool exists that could — the attempt itself must still be recorded in `audit_log`.
- Every step writes to both `llm_calls` (model, tokens, cost, latency, tool_name/args) and `audit_log` (`actor_type='agent'`, `on_behalf_of=user_id`).
- Empty retrieval → the model must answer "I don't have data on that," never a hallucinated guess.

**Non-goals:**
- Cross-session long-term memory.
- More than 4 tools, or any tool with real external side effects (no actual email sending, no actual write-outside-DB action).
- Token-by-token streaming UI (nice-to-have, not required for v1).

## Evals

**Problem:**
"I tested it manually and it seemed fine" is not evidence, and it's the specific gap the JD calls out with "AI evals & observability." An agent feature that ships without a regression gate is a feature nobody can safely change later.

**User:**
CI (blocks merges on regression), and future-me changing prompts/retrieval logic without a way to know if I made things worse.

**Success criteria:**
- `evals/dataset.jsonl` has at least 20 cases spanning `metric`, `lookup`, `retrieval`, `unanswerable`, and `injection` types.
- `evals/run.py` computes: recall@5 (retrieval cases), JSON-schema validity rate, citation-validity rate (deterministic, cheap, and convincing — per `question-banks.md`'s guidance on what carries interview weight), abstention rate on `should_refuse` cases, LLM-as-judge groundedness score, total cost, and p95 latency.
- Thresholds are explicit and versioned in the repo (initial targets: recall@5 ≥ 0.8, citation validity ≥ 0.95, 100% correct abstention on `should_refuse`/injection cases) — the run exits non-zero when any is breached.
- `make evals` runs the identical command CI runs — no drift between local and CI results.
- Wired into GitHub Actions so a regression blocks the merge, not just a local warning.

**Non-goals:**
- Continuous online eval monitoring against live production traffic.
- A human-labeling pipeline for growing the dataset beyond the initial hand-written cases.

## LedgerLens (Overview)

**Problem:**
The JD demands three things at once — product full-stack ability, reliable data pipelines, and safe AI features — and most portfolio projects only demonstrate the third (a "chat with your PDF" wrapper). Interviewers see dozens of those. An LLM layered on unvalidated data doesn't fix bad data, it makes wrong numbers sound more convincing — which is the exact failure mode a fintech/data-product employer is afraid of.

**User:**
Primary: the interviewer/hiring panel from `JD-for-outsourced-devs.md`, evaluating engineering judgment under the JD's specific anxieties (schema drift, duplicate events, unsafe agentic workflows, reconciliation). Secondary (in-fiction): a small investment firm's ops team using the dashboard to trust their numbers.

**Success criteria:**
- Every major capability implied by the target role — full-stack product work, reliable data pipelines with validation, safe agentic AI, RLS/RBAC/audit — has a named, working feature behind it, not just a mention. (The detailed line-by-line coverage table against the actual job posting is personal reference material, kept locally in the gitignored `interview-preps/` notes, not part of this repo.)
- The project can be pitched end-to-end (problem → architecture → the reconciliation before/after → the safety story) backed by a running system, not slides. See [`docs/PROJECT_OVERVIEW.md`](../docs/PROJECT_OVERVIEW.md) for the current pitch framing.
- Reconciliation drift is demonstrated before/after idempotency with a real number (target: a measurable % overstatement from duplicate events, down to 0 after the fix).
- Evals run in CI and block merges below threshold (see the "Evals" PRD section).
- Each stage below (Этап 1–7) has its own DoD satisfied per `CLAUDE.md` before being considered shippable.
- A human who has never seen the code can read the README alone and understand what's real, what's simulated, and what's deliberately missing.
- All infra (Vercel project + env vars, and CLI-orchestrated pieces where no native Pulumi provider exists — Supabase, Modal) is provisioned by a single Pulumi program in `infra/` — `pulumi up` is the one command that stands the whole deployment up, not manual dashboard clicking. See `docs/DEPLOYMENT.md`.

**Non-goals:**
- Production-grade multi-tenant billing, horizontal scale, or a real second AI provider integration.
- Full accounting-software feature parity (this is not QuickBooks) — only enough surface to make reconciliation and RAG meaningful.
- Mobile app / native client.

## Stretch (Этап 7)

**Problem:**
Once the core loop (Этап 1–6) is real, remaining JD surface area — GPU/serverless workloads, multi-tenant isolation proof, secrets/PII hygiene — is worth closing if time allows, but none of it should block the core story.

**User:**
Same interviewer audience, specifically the follow-up questions ("what about a second tenant," "how do you handle secrets") that come up if the core demo lands well.

**Success criteria (each item stands alone — attempt independently, none blocks another):**
- Whisper transcription runs as a Modal function (GPU/serverless), producing timestamped chunks ingested into `chunks` — closes the JD's transcription + GPU-workload item by name, not just "Whisper somewhere."
- A backfill script demonstrates idempotency directly: running it twice produces identical row counts and sums, shown in the README.
- A second tenant exists with a CI test proving org A cannot see org B's data anywhere — dashboard, agent, or direct query.
- README has explicit Secrets Management and PII Handling sections describing what's actually implemented (env/Supabase Vault for keys, which fields count as PII and where they're masked in logs/`audit_log`), not aspirational text.

**Non-goals:**
- None beyond the project-wide non-goals in the Overview section — Infrastructure as Code moved from "consciously skipped" to a core Overview success criterion (Pulumi), see ADR.

