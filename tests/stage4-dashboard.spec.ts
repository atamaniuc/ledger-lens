import { expect, test } from "@playwright/test";
import { ingest } from "./helpers/api";
import { signInBrowser } from "./helpers/auth";
import { ORG_A, ORG_B, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 4: the dashboard, asserted through the rendered page.
//
// The query layer is covered directly in stage4-queries.spec.ts. What these
// add is the half that only exists in the browser: that the page renders what
// the queries returned, that a tenant boundary holds in the DOM and not just
// in the result set, and that "live" means live.
//
// Every fabricated row is tagged and removed in afterAll. Stage 3's
// reconciliation check is tenant-wide rather than run-scoped, so a row left
// behind by a test shows up later as real drift in a real verdict.

const TAG = `stage4-${Date.now()}`;
let apiUrl: string;

test.beforeAll(async ({ request }) => {
  ({ apiUrl } = localStack());

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from invoices where org_id = ${ORG_A}`;
  if (count === 0) await ingest(request, ORG_A);
});

test.afterAll(async () => {
  await sql`delete from data_quality_results where details->>'test_tag' = ${TAG}`;
  await sql`delete from pipeline_runs where correlation_id = ${TAG}`;
});

test.describe("Stage 4 — the dashboard", () => {
  test("renders the figures for the signed-in tenant", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    await expect(page.getByTestId("signed-in-as")).toHaveText("alice@acme.test");
    await expect(page.getByTestId("metric-revenue")).not.toHaveText("—");
    await expect(page.getByTestId("metric-average")).not.toHaveText("NaN");
    await expect(page.getByTestId("invoice-rows").locator("tr")).not.toHaveCount(0);
  });

  test("another tenant's rows are absent from the DOM", async ({
    page,
    context,
    request,
  }) => {
    // Not "Acme's total does not appear on Globex's page". The mock provider
    // is deterministic under a fixed seed, so once both tenants have ingested
    // they hold the *same* amounts — and Globex's own legitimate total is
    // character-for-character Acme's. That assertion fails on correct
    // behaviour, which is how it was written the first time.
    //
    // A unique marker cannot collide. One invoice for Acme carrying a
    // customer name nothing else could produce: if it reaches Globex's page,
    // that is a leak and nothing else.
    const marker = `Cross Tenant Canary ${TAG}`;
    const [{ raw_event_id, run_id }] = await sql<
      { raw_event_id: number; run_id: string }[]
    >`
      insert into raw_events (org_id, external_id, payload, payload_hash, run_id, source, event_version)
      select ${ORG_A}, ${`canary-${TAG}`}, ${sql.json({ marker })},
             ${`hash-${TAG}`}, r.id, 'mock-provider', 'v1'
        from pipeline_runs r
       where r.org_id = ${ORG_A}
       order by r.started_at desc limit 1
      returning id as raw_event_id, run_id`;

    await sql`
      insert into invoices (org_id, raw_event_id, external_id, customer, amount_cents,
                            currency, status, issued_at, run_id, pipeline_version, transformed_at)
      values (${ORG_A}, ${raw_event_id}, ${`canary-${TAG}`}, ${marker}, 12345,
              'USD', 'open', now(), ${run_id}, 'v1', now())`;

    try {
      await signInBrowser(context, request, apiUrl, "bob@globex.test");
      await page.goto("/dashboard");
      await expect(page.getByTestId("signed-in-as")).toHaveText("bob@globex.test");

      // Asserted against the rendered page, not the query result: the
      // Definition-of-Done cross-tenant check has to hold where a person
      // would actually see the leak.
      await expect(page.locator("body")).not.toContainText(marker);
    } finally {
      await sql`delete from invoices where external_id = ${`canary-${TAG}`}`;
      await sql`delete from raw_events where external_id = ${`canary-${TAG}`}`;
    }
  });

  test("the freshness badge flips to stale when the newest ingest ages out", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");

    // The suite ingests once and reuses the rows, so "fresh" stops being true
    // two hours later for reasons that have nothing to do with the badge.
    // Shift the whole org forward so its newest ingest is now, preserving the
    // relative order other assertions read, and shift it back afterwards.
    const [{ delta }] = await sql<{ delta: string | null }[]>`
      select (now() - max(ingested_at))::text as delta
        from raw_events where org_id = ${ORG_A}`;
    // `max` over no rows is null, and `ingested_at + null::interval` would
    // null out every row this suite depends on with nothing to restore from.
    if (delta === null) throw new Error("ORG_A has no raw_events; the fixture never ingested");

    await sql`update raw_events set ingested_at = ingested_at + ${delta}::interval
               where org_id = ${ORG_A}`;

    try {
      await page.goto("/dashboard");
      await expect(page.getByTestId("freshness")).toHaveAttribute(
        "data-freshness",
        "fresh",
      );

      // Push every ingest past the two-hour threshold, then put it back.
      // Faster and more precise than waiting, and it exercises the boundary
      // rather than a mocked clock.
      await sql`update raw_events set ingested_at = ingested_at - interval '3 hours'
                 where org_id = ${ORG_A}`;
      try {
        await page.reload();
        await expect(page.getByTestId("freshness")).toHaveAttribute(
          "data-freshness",
          "stale",
        );
      } finally {
        await sql`update raw_events set ingested_at = ingested_at + interval '3 hours'
                   where org_id = ${ORG_A}`;
      }
    } finally {
      await sql`update raw_events set ingested_at = ingested_at - ${delta}::interval
                 where org_id = ${ORG_A}`;
    }
  });

  test("data health shows four checks, and a failing one renders red", async ({
    page,
    context,
    request,
  }) => {
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    const panel = page.getByTestId("data-health");
    await expect(panel).toBeVisible();
    // Four cells always — the panel's shape does not depend on which checks
    // happened to run.
    for (const name of ["freshness", "volume", "uniqueness", "reconciliation"]) {
      await expect(page.getByTestId(`check-${name}`)).toBeVisible();
    }

    const [run] = await sql<{ id: string; org_id: string }[]>`
      select id, org_id from pipeline_runs
       where org_id = ${ORG_A} and status in ('succeeded','failed')
       order by finished_at desc, id desc limit 1`;

    // A newer row for the same check supersedes the old one — the accumulate
    // rather than upsert behaviour the query layer has to get right.
    await sql`
      insert into data_quality_results (org_id, run_id, check_name, status, details)
      values (${run.org_id}, ${run.id}, 'reconciliation', 'fail',
              ${sql.json({ test_tag: TAG })})`;

    await page.reload();
    await expect(page.getByTestId("check-reconciliation")).toHaveAttribute(
      "data-state",
      "fail",
    );
  });

  test("a closed run with no results renders 'no verdict', not a pass", async ({
    page,
    context,
    request,
  }) => {
    // Reachable in production: the ingestion route catches a checks failure
    // and continues, so a run closes having written nothing.
    await sql`
      insert into pipeline_runs (org_id, kind, source, status, started_at, finished_at, correlation_id)
      values (${ORG_A}, 'incremental', 'mock-provider', 'succeeded', now(), now(), ${TAG})`;

    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    await expect(page.getByTestId("no-verdict")).toBeVisible();
    for (const name of ["freshness", "volume", "uniqueness", "reconciliation"]) {
      // Missing, not failing. Different facts, different remedies.
      await expect(page.getByTestId(`check-${name}`)).toHaveAttribute(
        "data-state",
        "missing",
      );
    }
  });

  test("a new run appears without a reload, and only one socket is opened", async ({
    page,
    context,
    request,
  }) => {
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));

    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    // Wait for the channel, not for the panel. Inserting before the
    // subscription reaches SUBSCRIBED tests nothing and fails intermittently
    // — which is exactly how it failed the first time it was written.
    await expect(page.getByTestId("live-state")).toHaveAttribute(
      "data-live",
      "live",
    );

    const runId = crypto.randomUUID();
    await sql`
      insert into pipeline_runs (id, org_id, kind, source, status, started_at, correlation_id)
      values (${runId}, ${ORG_A}, 'incremental', 'mock-provider', 'running', now(), ${TAG})`;

    // No reload anywhere in this test. The bridge hears the insert and
    // refreshes the server tree.
    await expect(page.locator(`[data-run-id="${runId}"]`)).toBeVisible({
      timeout: 15_000,
    });

    // A run belonging to the other tenant must not arrive. RLS applies to the
    // subscription exactly as it applies to a query.
    const foreignId = crypto.randomUUID();
    await sql`
      insert into pipeline_runs (id, org_id, kind, source, status, started_at, correlation_id)
      values (${foreignId}, ${ORG_B}, 'incremental', 'mock-provider', 'running', now(), ${TAG})`;
    await page.waitForTimeout(2_000);
    await expect(page.locator(`[data-run-id="${foreignId}"]`)).toHaveCount(0);

    // Removed here rather than in afterAll: the empty-state test below asks
    // whether Globex has any data, and a row left behind by this one would
    // make it skip itself.
    await sql`delete from pipeline_runs where id = ${foreignId}`;

    // One subscriber, not two. `PipelineStatusLive` consumes the bridge; if
    // it ever opens its own channel this is what catches it.
    const realtime = sockets.filter((url) => url.includes("/realtime/v1"));
    expect(realtime.length, `realtime sockets: ${realtime.join(", ")}`).toBe(1);
  });

  test("the empty state is an empty state, not an error", async ({
    page,
    context,
    request,
  }) => {
    const [{ runs }] = await sql<{ runs: number }[]>`
      select count(*)::int as runs from pipeline_runs where org_id = ${ORG_B}`;
    test.skip(runs > 0, "Globex has data in this database; nothing to assert");

    await signInBrowser(context, request, apiUrl, "bob@globex.test");
    await page.goto("/dashboard");

    // Zero rows under RLS is correct behaviour for a tenant with no data.
    // Rendering it as a failure would teach people to distrust a working
    // system — and it is the same shape the cross-tenant check produces.
    await expect(page.getByTestId("dashboard-empty")).toBeVisible();
    await expect(page.getByTestId("panel-error")).toHaveCount(0);
  });
});
