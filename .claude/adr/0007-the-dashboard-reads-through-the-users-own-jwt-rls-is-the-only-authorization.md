# 0007: the dashboard reads through the user's own JWT; RLS is the only authorization

Status: Accepted

## Context

Stages 1–3 built a pipeline that writes as itself. The ingestion route and
the webhook Edge Function hold the service-role key, which bypasses
Row-Level Security by design: there is no end user in that path for a policy
to key off, so `org_id` arrives in the request body and the code is trusted
to use it. That trust is bounded — those two entry points are small,
authenticated by a shared secret, and covered by tests that assert a
rejected call writes nothing at all.

Stage 4 introduces the first code path with a real end user behind it, and
the same trust does not transfer. A dashboard is many queries across seven
tables, growing every time a panel is added. Whatever mechanism scopes those
queries to the signed-in user's org has to hold on the hundredth query
written six months from now by someone who has not read this file.

Two mechanisms are available, and only one of them is already proven here.
Every table carries an RLS policy scoping `SELECT` to the orgs in the
caller's `memberships`, and `authenticated` holds `SELECT` and nothing else
(migration `20260818094500_stage2_explicit_data_api_grants.sql`). Those
policies are exercised twice over in the existing suite — by impersonating
the `authenticated` role in Postgres, and by signing in through GoTrue for
real, the second of which caught a seed defect the first could not. The
comment in `lib/supabase/service-client.ts` has anticipated this decision
since Stage 2: *"The dashboard (Stage 4) reads through the user's own JWT
instead, so RLS applies there normally."* This ADR is where that becomes a
decision rather than an assumption.

Stage 4 also introduces live updates (US-06), which raises the same question
in a second form: a Realtime subscription is another way to read rows, and
it needs an answer about authorization that matches the first one.

## Decision

The signed-in user's JWT is the dashboard's only credential, in both
directions. Postgres RLS is the authorization mechanism; no application code
filters by `org_id`.

- Reads happen in Server Components through `lib/supabase/server-client.ts`
  (`createServerClient` from `@supabase/ssr`), which carries the user's
  session from cookies. The query goes to Postgres as `authenticated` and
  the policy decides what comes back.
- Interactive reads and the Realtime subscription happen through
  `lib/supabase/browser-client.ts`, the same JWT, in the browser.
- `lib/supabase/service-client.ts` stays exactly what it is — the pipeline's
  credential, server-only, imported by nothing in Stage 4.
- **No API route sits between the dashboard and the database for reads.**
  Route handlers remain for writes and for the pipeline; the dashboard does
  not get a read-side BFF.
- The Realtime subscription listens for `INSERT` and `UPDATE` on
  `pipeline_runs`, never `*`, and calls `realtime.setAuth(accessToken)`
  before subscribing.

`pipeline_runs` joins the `supabase_realtime` publication (which holds no
tables today) in its own migration. `REPLICA IDENTITY` stays `DEFAULT`.

## Consequences

- Authorization is stated once, in SQL, and enforced by the database for
  every present and future query. A panel added later cannot forget to scope
  itself, because scoping is not something its author does.
- The existing RLS tests become tests of the dashboard's security, not just
  of the schema's. That is most of this decision's value: the guarantee was
  already proven, and this reuses the proof instead of creating a second
  thing to prove.
- Server-rendered reads mean the first paint carries real numbers rather
  than loading skeletons — worth stating because the PRD's North Star is a
  person looking at the page and judging whether the numbers can be trusted.
- **`@supabase/ssr` becomes a dependency**, and cookie-based session
  handling becomes something this project maintains: a middleware that
  refreshes tokens, and a callback route. `supabase-js` alone has no
  server-side session story, so this is the cost of server-side rendering
  with a real session rather than an optional extra.
- **Three Supabase clients now exist, and using the wrong one is a real
  mistake with an invisible symptom**: importing `service-client` into a
  dashboard query would work perfectly, return every tenant's rows, and pass
  any test that only checks the numbers are right. The names and the
  file-level comments are the only guard; the cross-tenant Definition-of-
  Done check is what would actually catch it.
- **Realtime DELETE events are excluded, permanently and for a stated
  reason.** Supabase's documentation is explicit that RLS is not applied to
  `DELETE`, because Postgres cannot verify access to a row that no longer
  exists; a subscription on `*` would deliver other tenants' primary keys.
  Nothing in this project deletes `pipeline_runs`, so the exclusion costs
  nothing today — but a later change that wants delete events has to solve
  the leak, not just widen the filter.
- Only `pipeline_runs` is live. Metric tiles refresh on navigation or on a
  Realtime-triggered invalidation, not continuously. Making every figure
  live would mean publishing `invoices` to the WAL for a dashboard nobody
  watches by the second.
- `REPLICA IDENTITY DEFAULT` means `old` records are unavailable. This
  feature never reads them; `FULL` would write the entire pre-image of every
  row to the WAL to provide data with no consumer.

## Alternatives considered

**API routes as a read-side BFF: client → `/api/dashboard/*` → service-role
client.** Rejected, and this is the alternative the decision exists to
refuse. It reads well — one place to shape payloads, one place to cache —
but the service role bypasses RLS, so every route must filter by `org_id` in
application code. That moves tenant isolation from a policy the database
enforces to a `where` clause a person has to remember, in a file that will
be copied to make the next endpoint. The failure mode is a cross-tenant leak
that the existing RLS tests cannot catch, because they exercise a door that
path does not use. `CLAUDE.md` forbids exactly this ("no RLS bypass", "no
cross-`org_id` query without explicit filter"); more to the point, adopting
it would make the project's strongest existing guarantee decorative.

**Everything client-side: browser client plus TanStack Query, no server
rendering.** A genuine option, and closer than the BFF. It is equally safe —
the same JWT, the same policies — and it gives one mental model instead of a
server/client split, with Realtime and ordinary queries sharing a client.
Rejected on product grounds rather than security: every tile would begin as
a spinner on every load, including the first impression, and the page's
entire purpose is being read and believed at a glance. The split this
decision accepts is the price of that.

**A `SECURITY DEFINER` function per panel, returning pre-aggregated
figures.** Attractive for the metric tiles — one round trip, aggregation
where the data lives. Rejected for now as premature: `SECURITY DEFINER`
bypasses RLS inside the function body, so each one would need its own
explicit `auth.uid()` check, re-introducing hand-written authorization in
the place this decision is trying to remove it from. Worth revisiting if a
tile's query becomes measurably slow — with the check written in, and the
reasoning recorded then.

**Publishing every table to `supabase_realtime`, not just `pipeline_runs`.**
Rejected as scope without a requirement. US-06 asks for pipeline status to
update live; nothing asks for invoices to. Each published table adds WAL
volume and another surface where the DELETE gap above applies.

---

## Amendment — 2026-08-19

Four corrections and one absorption, recorded here rather than in a separate
design document. `.claude/DESIGN.md` was deleted in the same change: it
restated this ADR and drifted from it three times in one week, and the parts
of it that were load-bearing are below.

**1. The publication holds two tables, not one.** The decision above named
only `pipeline_runs`. That is wrong for the requirement it serves. The data
quality verdict is written *after* `closeRun()` returns, so a bridge watching
`pipeline_runs` alone refreshes at the moment the run closes — before the
verdict exists — and never again. `data_quality_results` joins the
publication, and the subscription is two filtered channels:
`pipeline_runs` on `INSERT` and `UPDATE`, `data_quality_results` on `INSERT`.
Still never `*`; the DELETE reasoning above applies unchanged to both tables.

**2. `proxy.ts`, not `middleware.ts`.** Next.js 16 deprecates `middleware.ts`
in favour of a root `proxy.ts` exporting a function named `proxy`. The
`edge` runtime is not supported there and is not configurable — it runs on
`nodejs`. The handler body is still Supabase's standard session-refresh
pattern; only the filename and export name differ from every `@supabase/ssr`
example. The matcher is `['/dashboard/:path*']`.

**3. The live path refreshes the server tree, it does not invalidate a
client cache.** An earlier draft said the subscription would invalidate
TanStack Query keys. It cannot: the figures are rendered by Server
Components, which have no cache entry to invalidate, so the tiles would sit
stale behind a live-looking panel — precisely the false-green failure this
design exists to prevent. The subscription calls `router.refresh()`, which
re-runs the same server queries through the same policies. TanStack Query is
reserved for the genuinely client-side reads: lineage drill-down and invoice
pagination.

**4. One subscription, owned in one place.** The channel and the constant
describing it live in the refresh bridge. `PipelineStatusLive` consumes that
bridge and opens no channel of its own, so there is exactly one place where
the published tables and events are declared and asserted against.

**Absorbed from the deleted design document — the error-state contract.**
These are the substance of the PRD's counter-metric (false-green is worse
than no signal), not generic error plumbing:

- No session → `proxy.ts` redirects to `/login`; the dashboard never renders
  partially for an unauthenticated request.
- Signed in with no membership → an empty state, not an error. RLS correctly
  returns zero rows, and rendering that as a failure would teach users to
  distrust a working system.
- No data ingested yet → an empty state naming the next action.
- A failing quality check → red, in place, never collapsed behind a toggle
  and never softened to a warning.
- Data past the freshness threshold → the badge says stale. If the freshness
  query itself fails the badge says *unknown*; there is no path that renders
  stale or unknown data as fresh.
- A closed run that produced no results at all → *no verdict*, which is a
  real reachable state (the ingestion route catches a checks failure and
  continues) and is distinct from "everything passed". A check with no row is
  *missing*, distinct from *failing*.
- Realtime disconnects → fall back to interval refetching **and say so in the
  UI**. A frozen live panel that still looks live is the same false-green
  failure in a different costume.
- A query throws → that panel renders its error state and the rest of the
  page still renders. One failing tile does not blank the dashboard.

**Scope change carried over.** US-07 (the AI copilot chat panel) was written
P0 in the PRD but depends on the agent, which does not exist until Stage 5.
It moves to Stage 5; Stage 4's layout reserves the column and renders nothing
into it.
