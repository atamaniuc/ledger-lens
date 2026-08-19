import { expect, test } from "@playwright/test";
import { sql } from "./helpers/db";

// Stage 4: what the Realtime publication is allowed to carry.
//
// A publication is a privilege surface, not a convenience: every table in it
// streams row changes to any subscriber the policies let through. These
// assertions pin the surface so widening it is a deliberate edit with a
// failing test attached, rather than a line in a migration nobody reviews.

test.describe("Stage 4 — Realtime publication", () => {
  test("supabase_realtime carries exactly the two dashboard tables", async () => {
    const rows = await sql<{ tablename: string }[]>`
      select tablename
        from pg_publication_tables
       where pubname = 'supabase_realtime'
       order by tablename`;

    // Exactly, not "contains". Publishing `invoices` would work fine and
    // quietly put every row of the money table on the wire.
    expect(rows.map((r) => r.tablename)).toEqual([
      "data_quality_results",
      "pipeline_runs",
    ]);
  });

  test("the publication is not FOR ALL TABLES", async () => {
    const [{ puballtables }] = await sql<{ puballtables: boolean }[]>`
      select puballtables from pg_publication where pubname = 'supabase_realtime'`;

    // `for all tables` would pick up every future table automatically,
    // which is the opposite of the assertion above being meaningful.
    expect(puballtables).toBe(false);
  });

  test("both published tables keep REPLICA IDENTITY DEFAULT", async () => {
    const rows = await sql<{ relname: string; relreplident: string }[]>`
      select relname, relreplident
        from pg_class
       where relname in ('pipeline_runs', 'data_quality_results')
       order by relname`;

    // 'd' is DEFAULT. 'f' (FULL) would write the whole pre-image of every
    // row into the WAL to deliver `old` records nothing here reads.
    expect(rows).toEqual([
      { relname: "data_quality_results", relreplident: "d" },
      { relname: "pipeline_runs", relreplident: "d" },
    ]);
  });

  test("publishing granted no new privilege to authenticated", async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where grantee = 'authenticated'
         and table_schema = 'public'
         and table_name in ('pipeline_runs', 'data_quality_results')
       order by table_name, privilege_type`;

    // Realtime authorises a subscriber through the same grant and the same
    // policies a normal read uses. SELECT and nothing else, exactly as
    // migration 20260818094500 left it.
    expect(rows).toEqual([
      { table_name: "data_quality_results", privilege_type: "SELECT" },
      { table_name: "pipeline_runs", privilege_type: "SELECT" },
    ]);
  });
});
