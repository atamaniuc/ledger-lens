import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { ingest } from "./helpers/api";
import { ORG_A, ORG_B, BOB, asUser, sql } from "./helpers/db";

// Tenant isolation, checked two ways.
//
// Through Postgres directly, as the `authenticated` role with a JWT claim,
// and through PostgREST as a genuinely signed-in user. The second matters:
// impersonating a role never goes near GoTrue, and it was the PostgREST path
// that caught the seed writing NULL into auth.users.confirmation_token,
// which made every real sign-in fail with a 500 while every impersonated
// check kept passing.

// The local stack's anon key. Not a secret — it is a fixed, publicly
// documented development value — but read from the running stack rather
// than committed, so it cannot go stale.
let anonKey: string;
let supabaseUrl: string;

test.beforeAll(async ({ request }) => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }));
  anonKey = process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY;
  supabaseUrl = status.API_URL;

  // The positive control below needs Globex to actually own some rows.
  // Depending on another spec file having run first would make this file
  // pass or fail on alphabetical ordering, which is not a property worth
  // having — so it ensures its own precondition.
  const [{ count }] = await sql`
    select count(*)::int from invoices where org_id = ${ORG_B}`;
  if (count === 0) await ingest(request, ORG_B);
});

test.describe("Tenant isolation", () => {
  test("anon is refused on privileges, before RLS is consulted", async ({ request }) => {
    // Defence in depth: the grant is the outer door, RLS the inner one.
    const res = await request.get(`${supabaseUrl}/rest/v1/invoices?select=id&limit=1`, {
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).code).toBe("42501");
  });

  test("a real sign-in works", async ({ request }) => {
    const res = await request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: anonKey },
      data: { email: "bob@globex.test", password: "password123" },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).access_token).toEqual(expect.any(String));
  });

  test("a signed-in user sees zero rows of another tenant", async ({ request }) => {
    const auth = await request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: anonKey },
      data: { email: "bob@globex.test", password: "password123" },
    });
    const token = (await auth.json()).access_token as string;
    const headers = { apikey: anonKey, authorization: `Bearer ${token}` };

    const foreign = await request.get(
      `${supabaseUrl}/rest/v1/invoices?select=id&org_id=eq.${ORG_A}`, { headers });
    // The pass condition is an empty 200. A 403 would also hide the data but
    // would confirm the rows exist; RLS makes other tenants invisible.
    expect(foreign.status()).toBe(200);
    expect(await foreign.json()).toEqual([]);

    // Without this the assertion above proves nothing: a query returning
    // zero because the token is wrong looks identical to one returning zero
    // because RLS works.
    const own = await request.get(
      `${supabaseUrl}/rest/v1/invoices?select=id&org_id=eq.${ORG_B}&limit=5`, { headers });
    expect(own.status()).toBe(200);
    expect((await own.json()).length).toBeGreaterThan(0);
  });

  test("quality results are scoped the same way", async () => {
    const [foreign, own] = await asUser(BOB, async (tx) => [
      (await tx`select count(*)::int as c from data_quality_results where org_id = ${ORG_A}`)[0].c,
      (await tx`select count(*)::int as c from data_quality_results where org_id = ${ORG_B}`)[0].c,
    ]);
    expect(foreign, "saw another tenant's quality results").toBe(0);
    // Globex's own results exist because beforeAll ingested for it, and an
    // ingestion run always records a verdict — so this is a real positive
    // control rather than a >= 0 that can never fail.
    expect(own, "Globex cannot see its own quality results either").toBeGreaterThan(0);
  });
});
