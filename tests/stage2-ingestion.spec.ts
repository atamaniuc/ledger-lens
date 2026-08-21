import { expect, test } from "@playwright/test";
import { authed, ingest } from "./helpers/api";
import { ORG_A, ORG_B, sql } from "./helpers/db";

// Stage 2: auth on the trigger, counter balance, idempotency, and
// tenant-scoped idempotency across two orgs.
//
// Serial because these share pipeline state — a cursor, a run, a set of
// rows — and the idempotency assertions are about what a *second* pass does.
test.describe.configure({ mode: "serial" });

test.describe("Stage 2 — Ingestion & Transform", () => {
  let firstRun: Awaited<ReturnType<typeof ingest>>;

  test.beforeAll(async () => {
    // Start from empty pipeline state. Several assertions below are about
    // what a first run does; a run resuming from a previous suite's cursor
    // reads nothing at all, which would fail them for a reason that has
    // nothing to do with the code. The seeded orgs and users stay, so this
    // never depends on a full `supabase db reset`.
    //
    // Ordered DELETEs, not `truncate ... cascade` — and the reason is a
    // finding, not a preference (D-50). The transcription migration gave
    // `documents` a `raw_event_id` foreign key, which silently widened the
    // blast radius of the old truncate: cascading from `raw_events` took the
    // whole seeded corpus with it, and five retrieval assertions then failed
    // in a spec that never mentions ingestion. The seeded documents have no
    // `raw_event_id`, so deleting rows in dependency order leaves them alone
    // while still emptying the pipeline.
    await sql`delete from data_quality_results`;
    await sql`delete from quarantine`;
    await sql`delete from chunks where invoice_id is not null`;
    await sql`delete from invoices`;
    await sql`delete from raw_events`;
    await sql`delete from pipeline_runs`;
  });

  test("an unauthenticated trigger is rejected", async ({ request }) => {
    // The route writes with the service role and takes org_id from its body,
    // so this check is the only thing between a caller and any tenant. A
    // filter the caller controls is not tenant isolation.
    const res = await request.post("/api/ingestion/run", { data: { org_id: ORG_A } });
    expect(res.status()).toBe(401);
  });

  test("a malformed org_id is rejected before any database access", async ({ request }) => {
    const res = await request.post("/api/ingestion/run", {
      headers: authed(),
      data: { org_id: "not-a-uuid" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("org_id");
  });

  test("a first run reads, writes, quarantines and balances", async ({ request }) => {
    firstRun = await ingest(request, ORG_A);
    expect(firstRun.status).toBe("succeeded");
    expect(firstRun.rows_read).toBeGreaterThan(0);

    // The PRD's "zero silent drops" counter-metric, made checkable: every
    // record read landed in exactly one bucket.
    expect(firstRun.counters_balanced, JSON.stringify(firstRun)).toBe(true);
    expect(firstRun.rows_read).toBe(
      firstRun.rows_written + firstRun.rows_quarantined + firstRun.rows_deduplicated,
    );

    // The provider injects null customers. An empty quarantine would mean
    // validation stopped rejecting them, not that the data got clean.
    expect(firstRun.rows_quarantined, "nothing was quarantined — is nullFields chaos still on?")
      .toBeGreaterThan(0);
  });

  test("a second full pass writes nothing new", async ({ request }) => {
    const [{ count: before }] = await sql`
      select count(*)::int from invoices where org_id = ${ORG_A}`;

    // Rewound so this is a genuine second pass over the same upstream data,
    // rather than a run that read nothing because the cursor was drained.
    await sql`
      update pipeline_runs set cursor_to = null
       where org_id = ${ORG_A} and kind = 'incremental'`;

    const second = await ingest(request, ORG_A);
    const [{ count: after }] = await sql`
      select count(*)::int from invoices where org_id = ${ORG_A}`;

    expect(second.rows_read).toBe(firstRun.rows_read);
    expect(second.rows_written, "a re-ingest wrote new rows").toBe(0);
    expect(second.rows_deduplicated).toBe(second.rows_read);
    expect(after).toBe(before);
  });

  test("a second tenant's identical external_ids are not discarded", async ({ request }) => {
    // The Stage 2 review's CRITICAL finding: the idempotency key omitted
    // org_id, so org B hit ON CONFLICT DO NOTHING and vanished — no rows, no
    // error, run reported as succeeded.
    const globex = await ingest(request, ORG_B);
    expect(globex.status).toBe("succeeded");
    expect(globex.rows_written + globex.rows_deduplicated).toBeGreaterThan(0);
    expect(globex.counters_balanced).toBe(true);

    const [{ count }] = await sql`
      select count(*)::int from invoices where org_id = ${ORG_B}`;
    expect(count).toBeGreaterThan(0);
  });

  test("no raw event is left without a downstream row", async () => {
    const [{ count }] = await sql`
      select count(*)::int from raw_events r
       where not exists (select 1 from invoices i where i.raw_event_id = r.id)
         and not exists (select 1 from quarantine q where q.raw_event_id = r.id)`;
    expect(count, "orphaned raw events").toBe(0);
  });
});

test.describe("Privileges", () => {
  test("anon holds nothing on public tables", async () => {
    // anon holding INSERT/UPDATE/DELETE is harmless while RLS denies what no
    // policy allows — but it is exactly the state in which one forgotten
    // `enable row level security` becomes a public write endpoint.
    const rows = await sql`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'`;
    expect(rows.map((r) => `${r.table_name}.${r.privilege_type}`)).toEqual([]);
  });

  test("no Data API role holds DELETE or TRUNCATE, except the one that is meant to", async () => {
    // Everything the pipeline writes is append-only, because it records what
    // arrived and an edited record is a lost one.
    //
    // `chunks` is the single exception and it is named here rather than
    // waived by loosening the query: it is a derived index of *current* text
    // (Stage 5), so a document that loses a paragraph has to lose its tail
    // chunks — otherwise retrieval keeps answering from text the document no
    // longer contains. A second entry appearing in this list is a regression,
    // not a precedent.
    const allowed = ["service_role:chunks.DELETE"];

    const rows = await sql`
      select table_name, grantee, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('authenticated', 'service_role')
         and privilege_type in ('DELETE', 'TRUNCATE')`;
    expect(rows.map((r) => `${r.grantee}:${r.table_name}.${r.privilege_type}`).sort()).toEqual(
      allowed,
    );
  });
});
