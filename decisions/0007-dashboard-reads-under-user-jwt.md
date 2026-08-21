# 0007: The dashboard reads through the user's own JWT; RLS is the only authorization

Status: Accepted

## Context

Stages 1–3 wrote as themselves: the ingestion route and webhook hold the service-role key, which bypasses RLS by design — no end user to key policies off, `org_id` arrives in the body, code trusted to use it. That trust is bounded (two small entry points, shared-secret auth, tests). Stage 4 introduces the first real end-user path, and the trust does not transfer: a dashboard is many queries across seven tables, growing with every panel; whatever scopes them to the caller's org must hold on the hundredth query written by someone who has not read this file.

Every table already carries RLS `SELECT` policies scoped via `memberships`, and `authenticated` holds `SELECT` and nothing else (migration `20260818094500_stage2_explicit_data_api_grants.sql`); the policies are exercised twice — impersonating `authenticated` in Postgres, and real GoTrue sign-in (which caught a seed defect the first could not).

## Decision

The signed-in user's JWT is the dashboard's only credential, in both directions. Postgres RLS is the authorization; **no application code filters by `org_id`**.

- Server Components read via `lib/supabase/server-client.ts` (`@supabase/ssr`, cookies) → the query runs as `authenticated`, the policy decides. Browser reads and the Realtime subscription via `lib/supabase/browser-client.ts`, same JWT. `lib/supabase/service-client.ts` stays exactly what it is — the pipeline's credential, server-only, imported by nothing in Stage 4.
- **No read-side API/BFF routes**; route handlers remain for writes and the pipeline.
- Realtime: `pipeline_runs` on `INSERT`/`UPDATE` and `data_quality_results` on `INSERT` — never `*` (amended: the verdict is written *after* `closeRun()` returns, so `pipeline_runs` alone refreshes too early and never again). `setAuth(accessToken)` before subscribing; `REPLICA IDENTITY` stays `DEFAULT`.
- Session refresh lives in a root `proxy.ts` exporting `proxy` — Next 16 deprecates `middleware.ts`; the handler runs on `nodejs`; matcher `/dashboard/:path*`. The subscription calls `router.refresh()` — figures are Server-Component-rendered, so there is no client cache to invalidate. TanStack Query is reserved for genuinely client-side reads (lineage drill-down, invoice pagination).

## Consequences

- Authorization is stated once, in SQL, enforced for every present and future query. The existing RLS tests become the dashboard's security tests — the guarantee was already proven and is reused.
- First paint carries real numbers, not skeletons.
- `@supabase/ssr` becomes a dependency: token-refresh middleware and a callback route to maintain. Three clients now exist; importing `service-client` into a dashboard query works perfectly, returns every tenant's rows, and passes number-only tests — names and comments are the guard, the cross-tenant DoD check catches it.
- **DELETE events are excluded permanently**: Supabase's docs are explicit that RLS does not apply to `DELETE` (Postgres cannot verify access to a row that no longer exists); nothing deletes `pipeline_runs`. A later change wanting delete events must solve the leak, not widen the filter.
- Error-state contract (absorbed from `.claude/DESIGN.md`, deleted for restating and drifting from this ADR): no session → redirect to `/login`; signed in with no membership → empty state, not error; nothing ingested → empty state naming the next action; failing quality check → red, in place, never softened; stale data → badge says stale, a failed freshness query says *unknown* — no path renders stale as fresh; a closed run with no results → *no verdict*, distinct from passed; Realtime disconnect → interval refetching **and say so in the UI**; one failing tile renders its error, the rest still render.

## Alternatives considered

- **API routes as a read-side BFF (client → `/api/dashboard/*` → service-role client):** rejected, and the decision exists to refuse it — the service role bypasses RLS, so every route must filter by `org_id` in application code: tenant isolation becomes a `where` clause someone must remember in a copy-pasted file. The failure mode is a cross-tenant leak the existing RLS tests cannot catch, because that path does not use the door they exercise. CLAUDE.md forbids it.
- **All client-side (browser client + TanStack Query, no server rendering):** equally safe (same JWT, same policies), one mental model. Rejected on product grounds — every tile would begin as a spinner, including the first impression, and the page's purpose is being read and believed at a glance.
- **A `SECURITY DEFINER` function per panel returning pre-aggregated figures:** one round trip, aggregation where the data lives. Rejected as premature — each would bypass RLS inside the body and need its own explicit `auth.uid()` check, re-introducing hand-written authorization. Revisit if a tile's query becomes measurably slow, check written in.
- **Publishing every table to `supabase_realtime`:** scope without a requirement; each table adds WAL volume and another DELETE-gap surface.
