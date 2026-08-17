# 0002: Project layout — single Next.js app, no monorepo

Status: Accepted

## Context

Stage 1 (Mock Provider) can't start until the project has a physical
layout — brainstorming for it paused specifically on whether to scaffold
the full Next.js app immediately or defer that to Stage 4 (Dashboard) and
build Mock Provider as a standalone script in the meantime.

A second question surfaced alongside it: the build eventually needs both
a Next.js app (Node/Edge runtime) and Supabase Edge Functions (Deno
runtime, for the Stage 2 event-driven webhook). Two different JS
runtimes in one repo raised the question of whether a monorepo tool
(Nx, Turborepo) is warranted to coordinate them.

## Decision

1. **Scaffold the full Next.js app now**, at the repo root, before Stage
   1 code is written. Mock Provider becomes its first API route
   (`/api/mock-provider/*`). Every later stage (2–6) builds on the same
   app — no mid-project migration from a standalone script into a real
   app.
2. **No monorepo tooling (Nx/Turborepo).** The repo holds one deployable
   Next.js app plus a handful of small Supabase Edge Functions under
   `supabase/functions/` — the standard `supabase init` layout, not a
   separate workspace/package. Deno's native support for `npm:` specifiers
   and relative-path local imports is enough to share the
   transform/validation logic between the polling ingestion job (Next.js
   side) and the webhook Edge Function (Deno side) — see
   `.claude/DESIGN.md`'s "Project Layout" section for the concrete module
   boundary.
3. `infra/` (Pulumi) and `evals/` (Python) remain their own independent
   toolchains alongside the app, each with their own dependency file —
   not folded into a monorepo build graph either.

## Consequences

- One consistent codebase for the whole build — Stage 2 onward never has
  to migrate Stage 1's throwaway script into the real app structure.
- The Deno/Node split is handled by Deno's own npm-interop rather than by
  build tooling. This is genuinely less mature than a monorepo's
  coordinated dependency graph: if the shared transform module doesn't
  import cleanly into the Edge Function runtime in practice, the fallback
  is deliberate duplication (the module reimplemented in each runtime)
  backed by a shared test fixture that asserts both implementations agree
  — not reaching for Nx at that point. This is a real limitation accepted
  up front, not discovered later.
- No monorepo tooling means no cross-package dependency graph, no
  coordinated versioning, and no shared build cache — all irrelevant at
  this project's actual scale (one app, a few functions), so not a real
  cost here.
- Committing to Next.js immediately means the Mock Provider stage carries
  slightly more setup cost than a bare script would (Next.js app
  scaffold, routing conventions) before any chaos-flag logic is written.
  Accepted in exchange for never having to redo that setup later.

## Alternatives considered

- **Standalone script for Mock Provider, defer the Next.js app to Stage
  4.** Faster to start Stage 1 in isolation. Rejected: it guarantees a
  migration later (Stage 1's code has to move into the real app before
  Stage 4), which is exactly the kind of rework the project's own
  engineering standards (idempotent pipelines, no silent rewrites) argue
  against doing to itself.
- **Nx or Turborepo monorepo**, with the Next.js app and each Edge
  Function as separate packages. Would give a real coordinated dependency
  graph and shared-code enforcement between the Node and Deno runtimes.
  Rejected as unjustified complexity at this scale — one app, two or
  three tiny functions, no team to coordinate across, no CI matrix that
  needs per-package build caching. Revisit only if the number of
  independently-deployable packages grows past what a flat layout can
  reasonably hold.
- **Deno for the whole app** (Next.js can run under Deno), eliminating
  the two-runtime split entirely. Rejected: Next.js's own tooling,
  ecosystem, and deployment story (Vercel) are built around Node/Bun-style
  npm workflows; running the whole app under Deno would fight the
  framework instead of the framework fighting Deno interop in one small
  corner (the webhook function) of the codebase.
