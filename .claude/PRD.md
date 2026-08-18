# LedgerLens — Product Requirements

## LedgerLens (Overview)

**Status:** Draft
**Participants:** Solo project — PO/Engineering/Design/QA responsibilities collapsed to one person
**Timeline:** No fixed release date — paced against the interview timeline (tracked locally, not in this repo)

### Context & Business Value

**Problem:**
The target role demands three things at once — product full-stack ability, reliable data pipelines, and safe AI features — and most portfolio projects only demonstrate the third (a "chat with your PDF" wrapper). Interviewers see dozens of those. An LLM layered on unvalidated data doesn't fix bad data, it makes wrong numbers sound more convincing — which is the exact failure mode a fintech/data-product employer is afraid of.

**Business goal:**
Demonstrate senior engineering judgment across all three axes at once — product full-stack delivery, reliable data pipelines, and safe agentic AI — the exact combination most portfolio projects fail to cover together.

**Target audience:**
Primary: technical interviewers/hiring panels evaluating this combination of skills. Secondary (in-fiction, inside the product itself): a small investment firm's ops team trusting the numbers.

### Success Metrics

**North Star metric:**
The project can be pitched end-to-end (problem → architecture → the reconciliation before/after → the safety story) backed by a running, deployed system — not slides. See [`docs/PROJECT_OVERVIEW.md`](../docs/PROJECT_OVERVIEW.md) for the current pitch framing.

**Proxy metrics:**
- Reconciliation drift demonstrated before/after idempotency with a real measured percentage, down to 0 after the fix.
- Evals passing in CI, gating merges below threshold.
- Every stage's Definition of Done (per `CLAUDE.md`) satisfied before being considered shippable.

**Counter-metrics:**
- README/architecture readability — a reader who's never seen the code should understand what's real, what's simulated, and what's deliberately missing, without needing to ask.
- No stage ships with a DoD item silently skipped.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As an interviewer, I want to see a working system that closes the major capabilities implied by the role, so I can evaluate judgment, not just vocabulary. | P0 | Each of the 7 build stages has its own PRD entry and, once implemented, a working feature behind it. |
| US-02 | As an interviewer, I want a single deployed instance I can look at, so I don't have to run the project myself to evaluate it. | P0 | `docs/DEPLOYMENT.md`'s readiness checklist passes; `pulumi up` stands up the full deployable surface from a clean checkout. |
| US-03 | As a future reader of this repo, I want an honest account of what's real vs. simulated vs. missing, so I can trust the rest of the documentation. | P1 | README has a populated "What's missing" section, not a placeholder. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Free-tier deploy only (Vercel/Supabase/Modal) — see `docs/DEPLOYMENT.md`. Postgres RLS on every table (`CLAUDE.md` hard rule).

**Localization:** English only — the deployed product and its docs.

**Security/Legal:** No real PII — data is fictional/seeded. No `service_role` key or other secret in client code or in the repo, ever (`CLAUDE.md` hard rule).

### User Flow & Design

No single user flow at the product-overview level — see the per-stage entries below (Dashboard, RAG & Agent) for actual screens/states. Overall product flow: sign in → see pipeline/quality status → ask the AI copilot a question → get a cited, verifiable answer.

### Out of Scope

- Production-grade multi-tenant billing, horizontal scale, or a real second AI provider integration.
- Full accounting-software feature parity (this is not QuickBooks) — only enough surface to make reconciliation and RAG meaningful.
- Mobile app / native client.

## Mock Provider

**Status:** Approved — implemented and verified in Stage 1, no scope drift from these requirements
**Participants:** Solo project
**Timeline:** Stage 1

### Context & Business Value

**Problem:**
Without an upstream system that actually misbehaves, "idempotent ingestion" and "handles schema drift" are just vocabulary — there's nothing to demonstrate and nothing to test against.

**Business goal:**
Give every downstream claim (idempotency, resilience, reconciliation) something real to prove itself against, so the rest of the project isn't asserting untested properties.

**Target audience:**
Downstream: the ingestion job (Stage 2) and its tests. Narratively stands in for the real third-party accounting/payments API the target role's integration work would touch.

### Success Metrics

**North Star metric:**
Every chaos flag is independently toggleable and verifiably triggers its failure — no flag is decorative.

**Proxy metrics:**
Deterministic under a fixed seed (same seed → same failure sequence), so it doubles as a regression fixture, not just a demo toy.

**Counter-metrics:**
No chaos behavior should be so aggressive that a correctly-written client can never make progress — flags must be tunable, not maximal by default.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As the ingestion job, I want a cursor-paginated invoices endpoint, so I can pull data incrementally. | P0 | `GET /api/mock-provider/invoices` returns cursor-paginated pages. |
| US-02 | As the ingestion job under test, I want deterministic chaos flags, so I can write regression tests against specific failure modes. | P0 | Seven flags — `duplicates` (~5% repeat rate), `schemaDrift` (`amount` number→string after a cursor point), `nullFields` (`customer` null on some fraction), `rateLimit` (429+`Retry-After` every 10th request), `serverError` (500 every 25th), `expiredToken` (401 after N requests), `futureDates` (some `issued_at` in the future) — each independently toggleable via env var or query param. |
| US-03 | As the reconciliation check (Stage 3), I want an independent summary total, so I have something to compare against that isn't derived from the same data I'm validating. | P0 | `GET /api/mock-provider/summary` returns the provider's own aggregate total, computed independently of `/invoices`. |

### Non-Functional Requirements & Constraints

**Technical constraints:** In-memory/seeded dataset — no real persistence needed. Deterministic under a fixed seed.

**Localization:** N/A — internal test double, no user-facing text.

**Security/Legal:** No auth on the mock endpoint beyond the `expiredToken` chaos flag itself — this is a test double, not a real integration surface.

### User Flow & Design

No UI — this is an API-only test double. No screens/states.

### Out of Scope

- Real persistence.
- Auth on the mock endpoint beyond the `expiredToken` chaos flag.
- Modeling more than one upstream provider.

## Ingestion & Transform

**Status:** Approved — implemented and verified in Stage 2. Acceptance criteria above were amended during that stage: the review pass found the original US-03 wording specified an idempotency key without `org_id` (a spec defect, not just an implementation one) and that US-01/US-04 were under-specified about cursor terminal values and non-Zod write failures. See ADR 0004 and `.claude/DESIGN.md`.
**Participants:** Solo project
**Timeline:** Stage 2

### Context & Business Value

**Problem:**
Raw data from an adversarial provider has to become trustworthy rows without losing information or double-counting — and it has to survive being run twice, run out of order, or interrupted mid-page.

**Business goal:**
Make "reliable data pipeline with validation" a demonstrated property, not an assertion.

**Target audience:**
The transform stage (Stage 3) and the dashboard (Stage 4) both depend on `invoices`/`quarantine` being trustworthy. Also stands in for whoever operates the pipeline day-to-day (a data/platform engineer in a real org).

### Success Metrics

**North Star metric:**
Running ingestion twice against identical mock-provider output yields zero net new rows in `raw_events` — idempotency proven, not claimed.

**Proxy metrics:**
Circuit breaker opens after 5 consecutive failures; retry honors `Retry-After`; `pipeline_runs` row counts (`rows_read`/`rows_written`/`rows_quarantined`) are accurate per run.

**Counter-metrics:**
Zero silent drops — every raw record ends up in either `invoices` or `quarantine` with a reason, never neither.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As the pipeline, I want cursor-based incremental pulls, so a re-run picks up where the last one left off. | P0 | Cursor stored in `pipeline_runs.cursor_to`; next run resumes from it, not from scratch. A drained dataset stores the offset past the last consumed record, never `null` — storing the provider's terminal `null` verbatim would make every subsequent run a full re-scan. Resume reads only `kind='incremental'` runs with a non-null cursor, so a cursorless webhook run can't reset it. |
| US-02 | As the pipeline under provider outage, I want retry with backoff and a circuit breaker, so transient failures don't cascade into a stuck job. | P0 | Exponential backoff + jitter; honors `Retry-After` (delta-seconds; an HTTP-date form falls back to computed backoff rather than becoming a zero-delay retry); circuit breaker opens after 5 consecutive failures, reason recorded on `pipeline_runs.error`. A wall-clock budget ends the run cleanly before a serverless execution limit can abandon it mid-write. |
| US-03 | As the reconciliation check, I want ingestion to be idempotent, so re-running never inflates the numbers. | P0 | Two identical runs → zero net new `raw_events` rows, via `unique(org_id, source, external_id, event_version)` + `ON CONFLICT DO NOTHING`. The key **must** include `org_id`: without it a second tenant's identical `external_id` conflicts with the first tenant's row and is silently discarded. A conflict counts as a duplicate only when the raw event also already has an `invoices` or `quarantine` row — one without either is an orphan from an interrupted run and gets completed, not skipped. |
| US-04 | As a data consumer, I want invalid records quarantined instead of dropped, so nothing silently disappears. | P0 | Zod validation: valid → `invoices`; invalid → `quarantine` with populated `reason` and `raw_event_id` preserved. Applies to DB-level rejections too (a well-formed but impossible date, an over-length field), not just Zod failures — a single bad record never aborts the page. `rows_read = rows_written + rows_quarantined + rows_deduplicated` holds exactly on every run; an imbalance is a silent drop by definition. |
| US-05 | As the provider, I want to push events instead of only being polled, so ingestion is genuinely event-driven. | P1 | Deno Edge Function webhook (`provider-webhook`) reuses the same transform code and idempotency guarantee as the polling path — the same `validateInvoice` and the same atomic `ingest_raw_event` call, not a parallel reimplementation. Writes `kind='webhook'` so it never interferes with the polling path's cursor resume. |

### Non-Functional Requirements & Constraints

**Technical constraints:** At-least-once delivery + dedup is the actual contract — not exactly-once. One provider only, no generic adapter abstraction.

**Localization:** N/A.

**Security/Legal:** Same as project-wide — no secrets in client code, RLS on every table touched. Both ingestion entrypoints write with the service-role client (the pipeline acts as itself, not as an end user, so there is no user JWT for RLS to key off), which means both must authenticate their caller with a shared secret: `org_id` arrives in the request and would otherwise be an attacker-controlled tenant selector. `CLAUDE.md`'s "no cross-`org_id` query without explicit filter" is not satisfied by a filter the caller supplies.

### User Flow & Design

No direct UI — background job. Observable indirectly via `pipeline_runs` rows surfaced on the Dashboard (Stage 4). Every run carries a `correlation_id` (accepted from the caller or generated) on both its log lines and its `pipeline_runs` row, per `CLAUDE.md`'s project-wide logging contract.

### Out of Scope

- Exactly-once delivery guarantees beyond idempotent upsert.
- A generic multi-provider adapter abstraction.

## Data Quality & Reconciliation

**Status:** Draft
**Participants:** Solo project
**Timeline:** Stage 3. The project's actual differentiator.

### Context & Business Value

**Problem:**
A pipeline that ingests without checking itself is exactly the "AI on top of bad data" trap the whole project exists to avoid.

**Business goal:**
Turn "I built a pipeline" into "I built a pipeline that knows when it's lying to you" — the single strongest differentiator in the project.

**Target audience:**
The dashboard's Data Health panel (Stage 4) and the README's before/after artifact (the project's single strongest interview talking point) both depend on this stage's output.

### Success Metrics

**North Star metric:**
Reconciliation drift is demonstrated before/after idempotency with a real measured number — not zero by construction, actually measured going from nonzero to zero.

**Proxy metrics:**
All 4 checks (freshness, volume, uniqueness, reconciliation) run and record a `pass`/`warn`/`fail` status per `run_id`, every run.

**Counter-metrics:**
No check should produce false positives on a healthy run — thresholds (2h freshness, ±50% volume) tuned against realistic seed data before being trusted.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As an operator, I want a freshness check, so I know when data has gone stale. | P0 | `now() - max(ingested_at) < 2 hours` recorded in `data_quality_results` every run. |
| US-02 | As an operator, I want a volume check, so an unexpectedly small or large batch gets flagged. | P0 | Row count within ±50% of the trailing 7-day average. |
| US-03 | As an operator, I want a uniqueness check, so duplicate records are caught even if ingestion logic has a gap. | P0 | No duplicates on `(org_id, external_id)`. |
| US-04 | As an interviewer, I want to see the reconciliation drift before and after the idempotency fix, so I have concrete evidence the fix mattered. | P0 | The "before" number is captured once, during Stage 2 implementation — before the idempotent `unique` constraint + `ON CONFLICT DO NOTHING` lands — and preserved as a fixed artifact (numbers + a screenshot/log excerpt in the README). By Stage 3, idempotency is already a shipped P0 requirement, so "before" is never reproduced live against the running system — it is not a runtime toggle or a rollback. The "after" number comes from Stage 3's live reconciliation check against the already-idempotent pipeline. Both numbers shown in the README. |
| US-05 | As the dashboard, I want per-run check status, so a user can drill into which specific run failed which check. | P1 | Each check's status queryable per `run_id`, not just as a global flag. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Reconciliation compares against `/api/mock-provider/summary` — an independent source, not internal consistency.

**Localization:** N/A.

**Security/Legal:** N/A beyond project-wide RLS.

### User Flow & Design

Surfaced entirely through the Dashboard's Data Health panel (Stage 4) — no standalone UI of its own.

### Out of Scope

- Automated external alerting/paging (email, Slack, PagerDuty) — a dashboard badge is the v1 notification surface.
- Configurable thresholds via UI.

## Dashboard

**Status:** Approved — architecture agreed in Stage 4's Phase 1; see `.claude/DESIGN.md` ("Dashboard") and ADR 0007. One amendment made during that phase: US-07 was specified P0 but depends on an agent that does not exist until Stage 5, and moves there at P1 — see its row below.
**Participants:** Solo project — new UI routes through the `designer` agent per `CLAUDE.md`
**Timeline:** Stage 4

### Context & Business Value

**Problem:**
The pipeline and quality checks are invisible unless something surfaces them to a human — and the target role expects real frontend chops (Next.js/TS/Tailwind/TanStack Query/shadcn), auth, and real-time updates, not just a data table.

**Business goal:**
Prove full-stack product delivery, not just backend/data engineering — this is the screen an evaluator actually looks at.

**Target audience:**
The in-fiction investment firm's ops team, checking whether this month's numbers can be trusted before closing the books. Also the interviewer.

### Success Metrics

**North Star metric:**
A user can look at the dashboard and correctly judge whether this month's numbers can be trusted, without reading code.

**Proxy metrics:**
Freshness badge and Data Health panel both reflect true pipeline state within one Realtime update cycle (no manual refresh needed).

**Counter-metrics:**
No dashboard state should ever show stale data as fresh, or a failing check as passing — false-green is worse than no signal.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a user, I want to sign in before seeing any org's data, so unauthenticated access is impossible. | P0 | Supabase Auth (magic link) gates the dashboard; `memberships.role` determines which org's data is visible — verified by the RLS non-owner test in Definition of Done. |
| US-02 | As a user, I want revenue/invoice/average-invoice tiles, so I get the headline numbers at a glance. | P0 | Tiles render from `invoices`. |
| US-03 | As a user, I want a freshness badge, so I know if I'm looking at stale data. | P0 | Badge changes state (fresh/stale) crossing the 2-hour threshold — testable by manipulating `ingested_at` in a seeded run. |
| US-04 | As a user, I want a Data Health panel, so I can see all 4 quality checks at a glance. | P0 | Panel shows all 4 checks with latest pass/warn/fail status. |
| US-05 | As a user, I want to drill from a number down to its source records, so I can verify a figure instead of trusting it blindly. | P1 | Clicking a number shows contributing `raw_events`, `run_id`, source, timestamp, down to the raw payload. |
| US-06 | As a user, I want pipeline status to update live, so I don't have to manually refresh. | P1 | New `pipeline_runs` row appears without manual refresh (Supabase Realtime), verifiable with two concurrent sessions. |
| US-07 | As a user, I want to ask the AI copilot a question from the dashboard, so I don't need a separate tool. | ~~P0~~ **P1 — moved to Stage 5** | Chat panel round-trips at least one query to the agent and renders an answer with visible citations. **Amended during Stage 4's Phase 1:** this was specified P0 in a stage that does not contain an agent — it cannot be satisfied before Stage 5 builds one, and a stub panel would only be a P0 marked done without the behaviour it promises. It ships in Stage 5 alongside the agent it displays. Stage 4's layout reserves the column and renders nothing into it. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Cursor-paginated invoices table. New components ship with a co-located `*.stories.tsx` per `CLAUDE.md`'s Frontend rules (default/loading/empty/error states).

**Localization:** English only, no i18n.

**Security/Legal:** RLS-enforced org isolation — no client-side-only access control.

### User Flow & Design

Sign in (magic link) → land on single dashboard page → tiles + freshness badge + Data Health panel + invoices table + chat panel, all visible without navigation. Empty state: no data ingested yet. Error state: a failing quality check shown as a red badge, not hidden. Figma/Miro: none yet — design routes through the `designer` agent per `CLAUDE.md`, not a separate design tool.

### Out of Scope

- Full visual polish/animation — Tailwind + shadcn, three components, no custom motion work.
- Mobile-responsive layout or i18n.

## RAG & Agent

**Status:** Draft
**Participants:** Solo project
**Timeline:** Stage 5. Where the target role's core anxiety lives.

### Context & Business Value

**Problem:**
An AI feature that can act (not just answer) has to be safe by construction, not by a prompt asking it to behave. "I trust the model" is not an acceptable design.

**Business goal:**
Demonstrate a safe agentic workflow the way the target role actually cares about it — scoped tools, RLS-bounded execution, full audit trail — not a demo that only works because nobody tried to break it.

**Target audience:**
The dashboard's chat panel (consumer of this stage) and the interviewer evaluating "safe agentic workflows, scoped tools, evals" directly.

### Success Metrics

**North Star metric:**
A poisoned document in the corpus cannot cause the agent to do harm — not because it was told not to, but because no tool exists that could.

**Proxy metrics:**
Citation validity rate (deterministic check that cited ids were actually in retrieved context); recall@5 on a fixed evaluation query set (measured in the Evals stage).

**Counter-metrics:**
Zero unaudited agent actions — every tool call logged to both `llm_calls` and `audit_log`. Zero hallucinated answers on empty retrieval.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a user, I want hybrid search over documents, so retrieval isn't limited to exact keyword or pure-semantic matches alone. | P0 | Vector + full-text combined via Reciprocal Rank Fusion, returns sensible top-5 results for a fixed evaluation query set (verified quantitatively in Evals). |
| US-02 | As a user, I want the agent to answer from real data with citations, so I can verify the answer myself. | P0 | Responses cite `chunk_id`/`invoice_id`; deterministic check confirms cited ids were actually in retrieved context, else flagged unverified. |
| US-03 | As a security-conscious evaluator, I want the agent's tools scoped to the calling user's own permissions, so it can't be used to exfiltrate another org's data. | P0 | Every tool call executes under the calling user's JWT; RLS applies exactly as it does to the dashboard — verified by a test: org A user cannot retrieve org B's chunks or invoices through the agent, even indirectly. |
| US-04 | As a security-conscious evaluator, I want no tool capable of an irreversible side effect, so a poisoned document can't cause real damage. | P0 | Exactly 4 tools: `get_revenue_summary`, `list_invoices`, `search_documents` (read, auto-execute), `draft_customer_email` (draft only, no send capability exists anywhere in the system). |
| US-05 | As an auditor, I want every agent step logged, so any action (or attempted action) is traceable after the fact. | P0 | Every step writes to `llm_calls` (model, tokens, cost, latency, tool_name/args) and `audit_log` (`actor_type='agent'`, `on_behalf_of=user_id`), and every row in that request/step chain shares one `correlation_id` — per `CLAUDE.md`'s project-wide logging contract, not just an agent-specific convention. |
| US-06 | As a user, I want the agent to admit when it doesn't know, so I don't get a confident wrong answer. | P0 | Empty retrieval → model must answer "I don't have data on that," never a hallucinated guess. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Max 6 tool-call steps, 30s timeout, token ceiling enforced.

**Localization:** English only.

**Security/Legal:** No tool with real external side effects. JWT-scoped execution is the actual security boundary, not a system-prompt instruction.

### User Flow & Design

User types a question in the dashboard's chat panel → agent retrieves + reasons + optionally calls tools → answer rendered with citations. Empty retrieval → explicit "I don't have data" response, never silence or a guess. Prompt-injection attempt → agent attempts nothing harmful (no capable tool exists), attempt is visible in `audit_log`.

### Out of Scope

- Cross-session long-term memory.
- More than 4 tools, or any tool with real external side effects.
- Token-by-token streaming UI.

## Evals

**Status:** Draft
**Participants:** Solo project
**Timeline:** Stage 6

### Context & Business Value

**Problem:**
"I tested it manually and it seemed fine" is not evidence. An agent feature that ships without a regression gate is a feature nobody can safely change later.

**Business goal:**
Make AI evals & observability a demonstrated CI gate, not a manual habit — the specific gap the target role calls out.

**Target audience:**
CI (blocks merges on regression), and future-me changing prompts/retrieval logic without a way to know if I made things worse.

### Success Metrics

**North Star metric:**
A regression in retrieval quality, citation validity, or safety behavior gets caught by CI before merge — not discovered later by a user.

**Proxy metrics:**
recall@5, JSON-schema validity rate, citation-validity rate, abstention rate on unanswerable cases, LLM-as-judge groundedness score, cost, p95 latency — all computed and versioned.

**Counter-metrics:**
`task evals` never diverges from what CI runs — no "works locally, fails in CI" surprise.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a maintainer, I want a versioned eval dataset, so regressions are measured against a fixed bar, not a moving one. | P0 | `evals/dataset.jsonl` has at least 20 cases spanning `metric`, `lookup`, `retrieval`, `unanswerable`, `injection` types. |
| US-02 | As a maintainer, I want a single script that scores everything, so I don't have to manually check each dimension. | P0 | `evals/run.py` computes recall@5, JSON validity, citation validity, abstention rate, LLM-as-judge groundedness, cost, p95 latency. |
| US-03 | As CI, I want a hard threshold, so a regression fails the build instead of just producing a warning. | P0 | Explicit versioned thresholds (recall@5 ≥ 0.8, citation validity ≥ 0.95, 100% correct abstention on `should_refuse`/injection cases); run exits non-zero when breached. |
| US-04 | As a developer, I want to run the exact CI check locally, so I know before I push whether I broke something. | P0 | `task evals` runs the identical command CI runs. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Wired into GitHub Actions — regression blocks the merge, not just a local warning.

**Localization:** N/A.

**Security/Legal:** N/A.

### User Flow & Design

No UI — CLI script + CI job. Output: a results table + non-zero exit code on threshold breach.

### Out of Scope

- Continuous online eval monitoring against live production traffic.
- A human-labeling pipeline for growing the dataset beyond the initial hand-written cases.

## Stretch (Stage 7)

**Status:** Draft
**Participants:** Solo project
**Timeline:** Stage 7 — optional, attempted only if the core loop (Stages 1–6) is already real

### Context & Business Value

**Problem:**
Once the core loop is real, remaining target-role surface area — GPU/serverless workloads, multi-tenant isolation proof, secrets/PII hygiene — is worth closing if time allows, but none of it should block the core story.

**Business goal:**
Close follow-up-question surface area ("what about a second tenant," "how do you handle secrets") without risking the core demo's completeness.

**Target audience:**
Same interviewer audience, specifically the follow-up questions that come up if the core demo lands well.

### Success Metrics

**North Star metric:**
N/A at this stage's level — each item below stands alone with its own bar; no combined metric.

**Proxy metrics:**
Each attempted item's own acceptance criteria (see Functional Requirements).

**Counter-metrics:**
None of these items should be attempted at the cost of a core-loop (Stage 1–6) regression — this stage never trades against the core.

### Functional Requirements

| ID | User Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As an interviewer, I want to see a real GPU/serverless workload, so "Modal" isn't just a name-drop. | P2 | Whisper transcription runs as a Modal function, producing timestamped chunks ingested into `chunks`. |
| US-02 | As an interviewer, I want proof of idempotency beyond a claim, so I can see it demonstrated on demand. | P2 | Backfill script run twice produces identical row counts and sums, shown in the README. |
| US-03 | As an interviewer, I want to see multi-tenant isolation actually tested, not just designed. | P2 | Second tenant exists with a CI test proving org A cannot see org B's data anywhere — dashboard, agent, or direct query. |
| US-04 | As a reader, I want explicit secrets/PII documentation, so I don't have to infer the security model. | P2 | README has explicit Secrets Management and PII Handling sections describing what's actually implemented, not aspirational text. |

### Non-Functional Requirements & Constraints

**Technical constraints:** Each item independent — attempting one doesn't require attempting the others.

**Localization:** N/A.

**Security/Legal:** Secrets management and PII handling are the explicit subject of two of these items.

### User Flow & Design

No new user-facing flow beyond what Stages 1–6 already define; this stage documents and hardens, doesn't add new screens.

### Out of Scope

- Infrastructure as Code was previously listed here as consciously skipped — that decision reversed (see [ADR 0001](adr/0001-infrastructure-as-code-with-pulumi.md)); IaC via Pulumi is now a core Overview success criterion, not a Stage 7 item.

