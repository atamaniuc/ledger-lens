# Stage 4 — Dashboard: task list

Derived from `.omc/plans/2026-08-18-stage-4-dashboard.md` (revision 5), which
holds the reasoning behind every line here. Architecture is fixed by
`.claude/DESIGN.md` → "## Dashboard" and ADR 0007. Branch: `stage-4-dashboard`.

Tasks are grouped into batches. **A batch is one commit** — the tasks inside
it are one logical change, and splitting them would commit a contract without
its consumer. Every batch ends with a reviewer pass on its diff (Definition of
Done item 3) before the commit, not after.

Migrations stay sequential and single-agent (`CLAUDE.md`). Batches run in
order; there is a real dependency between each and the next.

---

## Batch A — Access foundation (one commit)

- [ ] **T1** `bun add @supabase/ssr`; `lib/supabase/server-client.ts`
      (`createServerClient`, cookie-backed) and `lib/supabase/browser-client.ts`
      (`createBrowserClient`).
- [ ] **T2** Root `proxy.ts`, named export `proxy`, matcher
      `['/dashboard/:path*']` — **not** `middleware.ts`, which Next 16.3.1
      deprecates. Supabase's handler body, Next's filename. Runs on the
      `nodejs` runtime, which is not configurable. Update
      `.claude/DESIGN.md`'s read-path sentence in the same commit.
- [ ] **T3** `no-restricted-imports` forbidding `lib/supabase/service-client`
      outside `app/api/**` and `supabase/functions/**`, plus a committed
      fixture proving the rule fires.
- [ ] **T4** `app/login/page.tsx` (magic link), `app/auth/callback/route.ts`,
      and `app/page.tsx` (still create-next-app boilerplate) replaced with a
      session-aware redirect.

**Done when:** unauthenticated `GET /dashboard` 307s to `/login`; a test
drives the proxy with an expired access token plus a valid refresh token and
asserts the session rotates and the page renders (local `jwt_expiry` is
3600s, so waiting out a token is not a test); deleting the lint rule fails
the fixture; the magic-link round trip completes against Mailpit; a grep for
`middleware.ts` across `app/`, the repo root and `.claude/DESIGN.md` returns
nothing.

## Batch B1 — Realtime publication (one commit, single agent)

- [ ] **T4a** Amend ADR 0007 in place with a dated amendment block: the
      publication holds `pipeline_runs` **and** `data_quality_results`, the
      subscription is two filtered channels, and why — the verdict is written
      after `closeRun()`, so a bridge watching only `pipeline_runs` refreshes
      before the verdict exists and never again. Sync `.claude/DESIGN.md`'s
      live-path paragraph. **Blocks T5.**
- [ ] **T5** `supabase/migrations/<ts>_stage4_publish_dashboard_tables_to_realtime.sql`
      adding both tables to `supabase_realtime`. `REPLICA IDENTITY` stays
      `DEFAULT`. Load `supabase:supabase-postgres-best-practices` before
      writing the SQL.

**Done when:** `task dev-reset` applies clean from empty; a test asserts
`pg_publication_tables` for `supabase_realtime` is exactly those two tables;
`authenticated` still holds `SELECT` and nothing more; `get_advisors`
security **and** performance show no new warnings against the 2026-08-18
baseline (security clean, performance 10 INFO `unused_index`).

## Batch B2 — Read contracts (one commit)

- [ ] **T6a** `lib/dashboard/queries.ts` — freshness from
      `max(raw_events.ingested_at)`; metrics over `invoices`; Data Health
      selects the newest **closed** run visible to the user *regardless of
      whether it has results*, then left-joins its checks taking the newest
      row per `(run_id, check_name)` via `distinct on`. A check with no row is
      *missing*, which is not the same as failing.
- [ ] **T6b** Invoice cursor `(issued_at desc, id desc)` with search-param
      transport; lineage payload (`run_id` plus the `raw_event_id` set).
- [ ] **T7** Pure functions + unit tests in `lib/dashboard/`: freshness at the
      2h boundary, metric derivations, status roll-up reusing `worstStatus`
      from `lib/data-quality/constants.ts`.

**Done when:** every shape returns expected counts for Acme and **zero rows**
for a non-member `org_id`; a two-disagreeing-runs fixture proves one run's
verdict is reported, not a blend; a fixture where the newest closed run has
no results proves the query returns that run with zero checks rather than an
older run's verdict; a fixture with two rows for one `check_name` proves only
the newer reaches the verdict; paging forward and back returns each row once
with no gap at a shared `issued_at`; average over zero invoices renders "—",
never `NaN`.

## Batch C — Refresh and observability (one commit)

- [ ] **T8a** Owns the subscription: the **exported constant**
      (`pipeline_runs` on INSERT/UPDATE, `data_quality_results` on INSERT,
      never `*`) and the bridge from those events to `router.refresh()`.
      `realtime.setAuth(token)` before subscribing. Two signals coalesced
      inside a short window, so four inserted check rows cause one re-render.
- [ ] **T8b** Observability: who owns `correlation_id` for a dashboard page
      request and across the Realtime lifecycle; a disconnect logs **once**
      with that id, not per retry.

**Done when:** an integration harness mounting this task's own subscriber
shows one refresh per completed run, driven by a run whose checks land after
`closeRun()`; a test asserts the constant holds exactly two tables with
INSERT/UPDATE and nothing else; a forced disconnect-reconnect produces
exactly one log line.

## Batch D — Design system (one commit)

- [ ] **T9** shadcn/ui init (Tailwind v4) + Storybook init; `components.json`
      fixes the component root.
- [ ] **T10** Token contract — one source for colour, spacing and badge
      states, plus a proof component rendering from tokens only.
- [ ] **T10a** Selection boundary: `components/dashboard/selection-context.tsx`,
      a client context holding the selected metric and T6b's lineage payload.
      Owns selection only — no data fetching. **Blocks T11 and T15.**

**Done when:** Storybook builds and runs; this exact command returns nothing —
`grep -rEn "#[0-9a-fA-F]{3,8}\b|[0-9]+(\.[0-9]+)?px" <components-root> --include="*.tsx" --include="*.ts"`;
selecting a tile then clearing it round-trips without a re-fetch.

## Batch E — Surfaces (two commits: E1 server panels, E2 client panels)

Every component goes through the `designer` agent, not ad-hoc component code,
and the `dataviz` skill is loaded before the metric tiles (`CLAUDE.md`,
Frontend section). Each ships a co-located `*.stories.tsx` covering default,
loading, empty and error — no exceptions, no "add story later".

**E1 (server):**
- [ ] **T11** `MetricTiles` (US-02) — each tile wraps its figure in T10a's
      client trigger. No selection state lives here.
- [ ] **T12** `FreshnessBadge` (US-03) — renders `unknown` when the freshness
      query itself fails; never defaults to fresh.
- [ ] **T13** `DataHealthPanel` (US-04) — four checks from one run, failing
      check red and not collapsible. Distinguishes **"no verdict"** (a closed
      run with no results — a real state, since the ingestion route catches a
      checks failure and continues) from "everything passed", and *missing*
      from *failing*.
- [ ] **T14** `InvoicesTable` (US-02) — consumes T6b's cursor contract.

**E2 (client):**
- [ ] **T15** `LineageDrillDown` (US-05) — reads T10a's context, then reads
      lineage rows under the user's JWT via `browser-client`.
- [ ] **T16** `PipelineStatusLive` (US-06) — a **consumer** of T8a's bridge,
      not a second subscriber. Renders run rows and a visible degraded state
      on disconnect; declares no channel of its own.

## Batch F — Composition and close-out (two commits: F1 page + e2e, F2 DoD)

- [ ] **T17** `app/dashboard/page.tsx` assembling T11–T16, mounting T10a's
      provider; empty state when the org has no data; the reserved empty
      column for Stage 5's chat panel.
- [ ] **T18** `tests/stage4-dashboard.spec.ts` — sessions created
      programmatically as `tests/rls.spec.ts` does; `afterAll` deletes every
      fabricated row keyed by a per-run tag, because Stage 3's reconciliation
      check is tenant-wide, not run-scoped.
- [ ] **T19** Amend ADR 0003: cron deferred to the first real deploy alongside
      `infra/` and Pulumi, with the advisory-lock precondition recorded
      against that work rather than forgotten.
- [ ] **T20** Definition of Done close-out — reviewer pass on the full diff;
      `get_advisors` re-checked; this file ticked; the three status docs
      (`PROGRESS.md` `## Current status`, `README.md` badge + `## Project
      status`, `docs/PROJECT_OVERVIEW.md` `## Where things stand`) synced **in
      the same commit**.

**E2E cases (T18):**
1. unauthenticated `/dashboard` redirects to `/login`;
2. as `bob@globex.test`, Acme's revenue figure is absent from the DOM;
3. freshness badge flips when `raw_events.ingested_at` is pushed past 2h;
4. Data Health shows four checks; one forced to `fail` renders red;
5. a **real** ingestion run: the run appears without reload **and** the Data
   Health panel shows that run's verdict once the checks land after
   `closeRun()`; a row for the other org does not appear;
6. a completed run whose checks produced no results renders "no verdict";
7. T8a's subscription constant is two tables, INSERT/UPDATE only, and no
   other channel is opened;
8. a forced Realtime disconnect shows the degraded state, recovers, and logs
   exactly once;
9. magic-link login via Mailpit's API, the message located by a per-run
   unique recipient so concurrent runs cannot read each other's mail.

---

## Close-out verification (run in this order)

1. `task dev-reset --yes` — migrations apply clean from empty.
2. `task check` — typecheck, lint (including T3), unit, deno.
3. `task types-check` — generated types match the schema after T5.
4. `task e2e` — 38 existing cases plus Stage 4's.
5. `get_advisors` security + performance, diffed against the baseline.
6. Cross-tenant check by hand in `psql` as a non-owner `org_id`: empty, not
   an error.
7. `git diff` scanned for secrets; the token grep from T10.
8. Reviewer pass on the whole diff before the closing commit.
