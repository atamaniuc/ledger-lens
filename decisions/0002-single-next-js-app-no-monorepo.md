# 0002: Project layout — single Next.js app, no monorepo

Status: Accepted

## Context

Stage 1 could not start until the layout was decided: scaffold the full Next.js app now, or defer it to Stage 4 and build Mock Provider as a standalone script. Alongside it: the build needs both a Next.js app (Node) and Supabase Edge Functions (Deno) — two runtimes — which raised whether monorepo tooling (Nx/Turborepo) is warranted.

## Decision

1. **Scaffold the full Next.js app now, at the repo root.** Mock Provider becomes its first API route (`/api/mock-provider/*`); every later stage builds on the same app — no mid-project migration from a throwaway script.
2. **No monorepo tooling.** One Next.js app plus a few Edge Functions in the standard `supabase init` layout. Deno's native `npm:` specifier and relative imports share transform/validation logic between the polling route and the webhook function — `lib/ingestion/transform.ts` is the boundary both runtimes import.
3. **`infra/` (Pulumi) and `evals/` (Python) stay independent toolchains**, each with its own dependency file.

## Consequences

- One consistent codebase; later stages never migrate Stage 1's script into the app.
- Deno npm-interop is less mature than a monorepo's dependency graph. If the shared module does not import cleanly into the Edge Function runtime, the fallback is deliberate duplication plus a shared test fixture asserting both implementations agree — not Nx.
- No cross-package graph, coordinated versioning, or shared build cache — irrelevant at one-app scale.
- The scaffold costs Stage 1 slightly more setup than a bare script; accepted in exchange for never redoing it.

## Alternatives considered

- **Standalone script, defer the app:** faster start, but guarantees a migration later — the rework this project's standards rule out doing to itself.
- **Nx/Turborepo monorepo:** a real coordinated graph between Node and Deno. Rejected as unjustified at this scale (one app, two or three tiny functions, no team, no CI matrix). Revisit if independently-deployable packages grow.
- **Deno for the whole app:** eliminates the runtime split. Rejected — Next.js's tooling and Vercel story are built around Node npm workflows; running the app under Deno would fight the framework to fix one small corner (the webhook).
