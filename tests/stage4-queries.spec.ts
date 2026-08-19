import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import {
  fetchDataHealth,
  fetchFreshness,
  fetchInvoicePage,
  fetchLineage,
  fetchMetrics,
} from "../lib/dashboard/queries";
import type { Database } from "../lib/supabase/database.types";
import { ingest } from "./helpers/api";
import { ORG_A, ORG_B, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Stage 4: the read contracts, exercised through a real signed-in user.
//
// The unit tests prove the arithmetic. These prove the thing the arithmetic
// sits on: that RLS, and not any `where org_id = …` in application code, is
// what decides which rows reach the page. Every query below is issued with a
// user's JWT and no tenant filter at all — if a policy regressed, Globex's
// client would start returning Acme's numbers and these would go red.

let apiUrl: string;
let anonKey: string;

async function clientFor(email: string): Promise<SupabaseClient<Database>> {
  const supabase = createClient<Database>(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password: "password123",
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return supabase;
}

test.beforeAll(async ({ request }) => {
  ({ apiUrl, anonKey } = localStack());

  // Own precondition rather than depending on file order: Acme needs data,
  // Globex needs none, and the whole point is telling those two apart.
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int from invoices where org_id = ${ORG_A}`;
  if (count === 0) await ingest(request, ORG_A);
});

test.describe("Stage 4 — read contracts under RLS", () => {
  test("a member sees their own org's figures", async () => {
    const supabase = await clientFor("alice@acme.test");

    const metrics = await fetchMetrics(supabase);
    expect(metrics.ok).toBe(true);
    if (!metrics.ok) return;
    expect(metrics.data.invoiceCount).toBeGreaterThan(0);
    expect(metrics.data.totalCents).toBeGreaterThan(0);
    // The positive control. Without it, every "zero rows" assertion below
    // would also pass against a policy that returns nothing to anybody.
    expect(metrics.data.averageCents).not.toBeNull();
  });

  test("a non-member gets zero rows, not an error and not another org's data", async () => {
    const supabase = await clientFor("bob@globex.test");

    const [{ acme }] = await sql<{ acme: number }[]>`
      select count(*)::int as acme from invoices where org_id = ${ORG_A}`;
    expect(acme, "Acme must have rows for this to prove anything").toBeGreaterThan(0);

    const metrics = await fetchMetrics(supabase);
    // Empty, not a 403. RLS makes other tenants invisible rather than
    // forbidden — a refusal would confirm the rows exist.
    expect(metrics.ok).toBe(true);
    if (!metrics.ok) return;

    const [{ globex }] = await sql<{ globex: number }[]>`
      select count(*)::int as globex from invoices where org_id = ${ORG_B}`;
    expect(metrics.data.invoiceCount).toBe(globex);
  });

  test("freshness reads the newest ingest, and reports an org with none as empty", async () => {
    const alice = await fetchFreshness(await clientFor("alice@acme.test"));
    expect(alice.ok).toBe(true);
    if (alice.ok) expect(["fresh", "stale"]).toContain(alice.data.state);

    const [{ globex }] = await sql<{ globex: number }[]>`
      select count(*)::int as globex from raw_events where org_id = ${ORG_B}`;
    const bob = await fetchFreshness(await clientFor("bob@globex.test"));
    expect(bob.ok).toBe(true);
    if (bob.ok && globex === 0) {
      // Never "stale": a tenant who has not ingested is not out of date.
      expect(bob.data.state).toBe("empty");
    }
  });

  test("data health reports the newest closed run, with or without results", async () => {
    const supabase = await clientFor("alice@acme.test");
    const health = await fetchDataHealth(supabase);
    expect(health.ok).toBe(true);
    if (!health.ok) return;

    expect(health.data.run).not.toBeNull();
    expect(["succeeded", "failed"]).toContain(health.data.run?.status);
    // Four cells always, whatever the run produced.
    expect(health.data.cells).toHaveLength(4);

    // And it is genuinely the newest closed run, not the newest run that
    // happens to carry results.
    const [newest] = await sql<{ id: string }[]>`
      select id from pipeline_runs
       where org_id = ${ORG_A} and status in ('succeeded','failed')
       order by finished_at desc, id desc
       limit 1`;
    expect(health.data.run?.id).toBe(newest.id);
  });

  test("invoice paging walks forward without gaps or repeats", async () => {
    const supabase = await clientFor("alice@acme.test");

    const first = await fetchInvoicePage(supabase, null, 5);
    expect(first.ok).toBe(true);
    if (!first.ok || !first.data.nextCursor) return;

    const second = await fetchInvoicePage(supabase, first.data.nextCursor, 5);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const firstIds = first.data.rows.map((r) => r.id);
    const secondIds = second.data.rows.map((r) => r.id);

    // No repeat across the boundary — the failure mode a plain `issued_at`
    // cursor produces when a batch shares a timestamp.
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);

    // And no gap: the two pages together are the first ten rows of the same
    // ordering, which is what a keyset cursor is supposed to guarantee.
    const ten = await fetchInvoicePage(supabase, null, 10);
    expect(ten.ok).toBe(true);
    if (ten.ok) {
      expect([...firstIds, ...secondIds]).toEqual(ten.data.rows.map((r) => r.id));
    }
  });

  test("lineage resolves only raw events the caller can see", async () => {
    const alice = await clientFor("alice@acme.test");
    const page = await fetchInvoicePage(alice, null, 3);
    expect(page.ok).toBe(true);
    if (!page.ok || page.data.rows.length === 0) return;

    const payload = {
      runIds: [...new Set(page.data.rows.map((r) => r.run_id))],
      rawEventIds: page.data.rows.map((r) => r.raw_event_id),
    };

    const mine = await fetchLineage(alice, payload);
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.data.length).toBe(payload.rawEventIds.length);

    // The same ids, asked for by someone from the other tenant. Not an
    // error — nothing.
    const theirs = await fetchLineage(await clientFor("bob@globex.test"), payload);
    expect(theirs.ok).toBe(true);
    if (theirs.ok) expect(theirs.data).toEqual([]);
  });
});
