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

