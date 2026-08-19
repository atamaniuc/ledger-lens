import { describe, expect, it } from "bun:test";
import { REFRESH_COALESCE_MS, SUBSCRIBED_TABLES } from "./realtime";

// The subscription contract, asserted rather than described. Widening it
// should require editing a test that says why it is narrow.

describe("SUBSCRIBED_TABLES", () => {
  it("covers exactly the two published tables", () => {
    expect(SUBSCRIBED_TABLES.map((t) => t.table).sort()).toEqual([
      "data_quality_results",
      "pipeline_runs",
    ]);
  });

  it("never subscribes to DELETE, on any table", () => {
    // RLS is not applied to DELETE events — Postgres cannot verify access to
    // a row that no longer exists — so a delete subscription would deliver
    // other tenants' primary keys.
    for (const { table, events } of SUBSCRIBED_TABLES) {
      expect(events, `${table} must not listen for deletes`).not.toContain(
        "DELETE" as never,
      );
    }
  });

  it("never subscribes to every event", () => {
    // `*` is how DELETE gets back in without anyone editing the list above.
    for (const { events } of SUBSCRIBED_TABLES) {
      expect(events).not.toContain("*" as never);
      expect(events.length).toBeGreaterThan(0);
    }
  });

  it("listens for runs appearing and changing, and results only appearing", () => {
    const byTable = Object.fromEntries(
      SUBSCRIBED_TABLES.map((t) => [t.table, [...t.events].sort()]),
    );
    expect(byTable.pipeline_runs).toEqual(["INSERT", "UPDATE"]);
    // Results are never updated in place; a retry inserts a new row.
    expect(byTable.data_quality_results).toEqual(["INSERT"]);
  });

  it("says why each table is there", () => {
    for (const { table, reason } of SUBSCRIBED_TABLES) {
      expect(reason.length, `${table} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe("REFRESH_COALESCE_MS", () => {
  it("is long enough to batch one run's writes and short enough to feel live", () => {
    // A completed run writes four result rows in one transaction and closes
    // its own row around them. Zero would re-render five times; a second
    // would stop being "live".
    expect(REFRESH_COALESCE_MS).toBeGreaterThan(100);
    expect(REFRESH_COALESCE_MS).toBeLessThanOrEqual(1000);
  });
});
