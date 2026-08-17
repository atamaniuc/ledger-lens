# LedgerLens — Approved Architecture

Per `CLAUDE.md` Phase 1 step 3 and the `design` skill: each `## <stage>`
section here records the architecture `/superpowers:brainstorming`
converged on for that stage — components, data flow, error handling,
testing plan — with cross-links to the `.claude/PRD.md` entry it satisfies
and any `.claude/adr/` decisions that justify a non-obvious choice.

Project layout is approved (see "Project Layout" below, ADR 0002) — that
was the one open question blocking Stage 1 from starting. Stage-specific
design sections (Mock Provider's own component/data-flow breakdown, etc.)
get added here as each stage's brainstorming converges — per the `design`
skill's own rule, this file records decisions that have been made, not
exploration in progress.

Scaffold a stage's section once its design is approved:

```bash
scripts/harness/new-design-section.sh "<stage name>"
make design FEATURE="<stage name>"
```
## Project Layout

**PRD:** .claude/PRD.md#ledgerlens-overview
**ADR(s):** .claude/adr/0002-project-layout-single-next-js-app-no-monorepo.md

**Overview:**
LedgerLens is one Next.js app (TypeScript, Bun) at the repo root, scaffolded before Stage 1 rather than deferred to Stage 4. Supabase Edge Functions (Deno) live co-located under `supabase/functions/`, following the standard `supabase init` layout — not a separate package or workspace. No Nx/Turborepo/monorepo tooling: there is exactly one deployable JS/TS app plus a couple of small Edge Functions with no coordinated-build need between them.

**Components:**
- `app/` — Next.js routes, including `/api/mock-provider/*` (Stage 1) and later the dashboard (Stage 4). Depends on: Supabase client libs, Zod, TanStack Query.
- `supabase/migrations/` — SQL schema (from `docs/DATABASE_SCHEMA.md`). Depends on: nothing in this repo; consumed by `supabase db push`.
- `supabase/functions/provider-webhook/` — Deno Edge Function, the event-driven ingestion path (Stage 2). Depends on: the shared transform/validation module (see below), imported via relative path or `npm:` specifier — not Node-specific APIs.
- Shared transform/validation module (`lib/transform.ts` or similar, exact path TBD at Stage 2) — runtime-agnostic (Deno + Node compatible), imported by both the polling ingestion job and the webhook Edge Function so "same transform code" (PRD US-05) is literal, not just behavioral parity.
- `infra/` — Pulumi program (TypeScript), its own `package.json`, deployed independently of the app's own build.
- `evals/` — Python, independent toolchain.

**Data flow:**
No new data flow beyond what `docs/PROJECT_OVERVIEW.md`'s architecture diagram already shows — this section is about where the code that implements that flow physically lives, not the flow itself.

**Error handling:**
N/A at the layout level — deferred to each stage's own DESIGN.md section.

**Testing plan:**
Layout itself isn't independently tested; validated indirectly by later stages actually building on it without a mid-project restructure. If the shared transform module turns out not to import cleanly into Deno, that's a signal to fall back to duplication + a shared test fixture (see ADR 0002 Consequences) rather than reaching for monorepo tooling.

**Open questions / risks:**
- Exact path/name of the shared transform module — decided at Stage 2 implementation time, not here.
- If Deno import friction turns out worse than expected in practice, revisit the "same code" approach (duplication + shared fixture is the documented fallback, not a monorepo).

## Ingestion & Transform

**PRD:** `.claude/PRD.md` — "Ingestion & Transform" section (US-01..US-05).
**ADR(s):** [0003](adr/0003-bounded-per-invocation-polling-ingestion-no-job-queue.md) — bounded per-invocation polling, no job queue.

**Overview:**

One polling ingestion path (Next.js API route) and one push path (Deno
webhook Edge Function) both funnel through the same transform module, so
idempotency and validation are proven once and reused, not reimplemented
twice — the exact requirement in US-05.

**Components:**

- `lib/ingestion/transform.ts` — pure functions, no I/O. `validateInvoice(raw): { ok: true, invoice } | { ok: false, reason }` (Zod schema against the mock provider's `RawInvoice` shape). Shared verbatim by both paths: the Next.js route imports it as a relative TS import; the Deno function imports the same file via a relative path per ADR 0002 (Deno resolves local `.ts` imports natively, no build step needed).
- `lib/ingestion/backoff.ts` — `withRetry(fn, opts)`: exponential backoff + jitter, honors `Retry-After` when the mock provider returns 429, and a simple consecutive-failure counter the caller uses to trip its own circuit breaker (breaker decision stays in the route/function, not hidden in this helper — keeps the retry primitive reusable and boring).
- `app/api/ingestion/run/route.ts` — `POST`. Reads the last succeeded run's `pipeline_runs.cursor_to` as `cursor_from`; loops pages up to `MAX_PAGES_PER_RUN`; per page: fetch (via `withRetry`) -> for each raw record, `INSERT ... ON CONFLICT (source, external_id, event_version) DO NOTHING RETURNING id` into `raw_events` -> if a row came back (genuinely new), run it through `transform.ts` -> `invoices` on success, `quarantine` (with `reason`) on failure; if no row came back (conflict = already ingested), skip transform entirely — that's the idempotency guarantee, not a re-derivation of it. Writes a `pipeline_runs` row up front (`status=running`), updates it to `succeeded`/`failed` with counts and `cursor_to` on exit, including on circuit-breaker abort.
- `supabase/functions/provider-webhook/index.ts` — Deno Edge Function. Verifies a shared-secret header (env var, not committed), parses one event payload matching the same `RawInvoice` shape, runs it through the identical `raw_events` insert + `transform.ts` + `invoices`/`quarantine` logic as the polling route. No pagination, no cursor — one event per call.

**Data flow:**

```
mock-provider /invoices --poll--> ingestion route --raw_events(insert, dedup)--> transform.ts --ok--> invoices
                                                                              --fail--> quarantine
mock-provider (push, simulated) --webhook--> provider-webhook --same raw_events/transform/invoices/quarantine path
```

Every write in both paths carries the owning `pipeline_runs.run_id` and the source `raw_events.id`, so `invoices`/`quarantine` rows are traceable back to the exact raw payload and pipeline run that produced them (lineage — see `docs/PROJECT_OVERVIEW.md`'s architecture diagram).

**Error handling:**

- Page fetch fails (network/5xx/429): `withRetry` backs off and retries; 5 consecutive failures trip the circuit breaker, the run aborts with `status=failed`, `error` populated, `cursor_to` left at the last page that fully succeeded — never advanced past a page that wasn't fully written.
- Record fails Zod validation: never dropped, never blocks the page — goes to `quarantine` with a `reason`, page processing continues. This is US-04's whole point.
- Webhook auth failure (missing/wrong shared secret): `401`, nothing written, no `pipeline_runs` row created for a rejected call (nothing happened, nothing to record).
- Duplicate delivery (either path): `ON CONFLICT DO NOTHING` on `raw_events` makes re-delivery a no-op past that point — this is what US-03's idempotency claim actually rests on.

**Testing plan:**

- Idempotency: run the ingestion route twice against identical mock-provider output (chaos flags off for this test — determinism matters more than chaos here), assert zero net new `raw_events` rows on the second run. This is the PRD's own North Star metric, not just a nice-to-have test.
- Quarantine: force `nullFields`/`schemaDrift` chaos on, assert every record lands in either `invoices` or `quarantine`, never neither, and `quarantine.reason` is non-empty.
- Circuit breaker: point the route at a URL that always 500s, assert it aborts after exactly 5 consecutive failures and `pipeline_runs.status = failed`.
- Webhook: POST one valid + one invalid event, assert the same `invoices`/`quarantine` outcome the polling path would produce for the same payload — proving actual code reuse, not just similar behavior.

**Open questions / risks:**

- The mock provider (Stage 1) only exposes a pull API — it does not itself push to the webhook. `provider-webhook` is proven with directly-POSTed test payloads, documented as "how a real provider would call it," not driven end-to-end by the mock provider. Extending Stage 1 to actually push is out of scope for Stage 2 (would be scope drift into Stage 1) — flag if a future stage needs it.
- No cross-invocation lock yet (see ADR 0003 consequences) — fine at today's single-tenant manual-trigger volume, revisit before Stage 4's cron is live alongside manual triggers.

