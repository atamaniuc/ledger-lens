import { expect, test } from "@playwright/test";
import { sql } from "./helpers/db";

// The invariant every other claim in this repository rests on: RLS is the
// authorization mechanism, so a table that arrives without it is not a smaller
// bug than a wrong number — it is the same bug earlier.
//
// This file asserts the invariant against the catalog rather than against a
// list someone maintains by hand, so a migration that adds a table without RLS
// fails here on the next run instead of being noticed by a reader. Closes D-30.
//
// The exceptions are named in code, not in prose: `chunks` is the one table
// where the Data API role holds DELETE, because it is a derived index of
// current text and a document that loses a paragraph has to lose its tail
// chunks. Everything else is append-only because it records what arrived.
const SERVICE_ROLE_DELETE_ALLOWED = new Set(["chunks"]);

interface TableRls {
  table: string;
  rls_enabled: boolean;
  policies: number;
}

interface Grant {
  table: string;
  grantee: string;
  privilege: string;
}

let tables: TableRls[];
let grants: Grant[];

test.beforeAll(async () => {
  tables = await sql<TableRls[]>`
    select c.relname                as table,
           c.relrowsecurity         as rls_enabled,
           (select count(*)::int
              from pg_policies p
             where p.schemaname = 'public'
               and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
     order by c.relname`;

  grants = await sql<Grant[]>`
    select table_name as table, grantee, privilege_type as privilege
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated', 'service_role')
     order by table_name, grantee, privilege_type`;
});

test.describe("RLS coverage", () => {
  test("the schema has tables at all — the guard cannot pass by finding nothing", () => {
    expect(tables.length).toBeGreaterThan(5);
  });

  test("every table in public has row level security enabled", () => {
    const without = tables.filter((t) => !t.rls_enabled).map((t) => t.table);
    expect(without, `tables without RLS: ${without.join(", ")}`).toEqual([]);
  });

  test("anon holds no privilege on any table — the outer door before RLS", () => {
    const anon = grants.filter((g) => g.grantee === "anon");
    expect(anon.map((g) => `${g.table}.${g.privilege}`)).toEqual([]);
  });

  test("authenticated holds SELECT only — no write path exists for an end user", () => {
    const writes = grants
      .filter((g) => g.grantee === "authenticated" && g.privilege !== "SELECT")
      .map((g) => `${g.table}.${g.privilege}`);
    expect(writes, `unexpected authenticated write grants: ${writes.join(", ")}`).toEqual([]);
  });

  test("a table readable by authenticated carries at least one policy", () => {
    // A SELECT grant with no policy returns nothing, which is safe but is
    // always a mistake: either the policy was forgotten or the grant was.
    const readable = new Set(
      grants
        .filter((g) => g.grantee === "authenticated" && g.privilege === "SELECT")
        .map((g) => g.table),
    );
    const unpolicied = tables
      .filter((t) => readable.has(t.table) && t.policies === 0)
      .map((t) => t.table);
    expect(unpolicied, `granted SELECT but no policy: ${unpolicied.join(", ")}`).toEqual([]);
  });

  test("service_role holds DELETE only where an ADR allows it", () => {
    const deletes = grants
      .filter((g) => g.grantee === "service_role" && g.privilege === "DELETE")
      .map((g) => g.table)
      .filter((t) => !SERVICE_ROLE_DELETE_ALLOWED.has(t));
    expect(deletes, `service_role DELETE outside the allowance: ${deletes.join(", ")}`).toEqual(
      [],
    );
  });
});
