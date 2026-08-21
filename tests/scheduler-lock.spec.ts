import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { authed } from "./helpers/api";
import { ORG_A, sql } from "./helpers/db";

// Spec 0003 (lane W2-B), AC-02/AC-03 (D-12): one run at a time per org.
//
// Two mechanisms, tested at the level each actually guarantees:
//
//  * The org's advisory lock (AC-02): two sessions trying pg_try_advisory_
//    lock on the same org key — exactly one wins. The route refuses a start
//    while the lock is held with 409 + reason 'advisory_lock_busy' — a clean
//    refusal, not a crash — and accepts one once the lock is released.
//  * The partial unique index (AC-03): at most one pipeline_runs row per org
//    can be 'running'; a second insert violates it. The route turns that
//    state into 409 + reason 'already_running' via the pre-check inside
//    try_start_polling_run.
//
// The advisory-lock cases need a second, pinned connection: advisory locks
// are session-scoped, and within one session they are reentrant, so the
// contention only shows between distinct sessions. sql.reserve() gives us
// deterministic pins from the shared pool; pg_advisory_unlock_all() before release
// keeps the locks from leaking back into the pool.

test.describe.configure({ mode: "serial" });

const lockKey = (org: string) =>
  `select pg_try_advisory_lock(hashtext('ledgerlens_run'), hashtext('${org}')) as got`;

test.describe("the org advisory lock (AC-02)", () => {
  test("of two concurrent sessions, exactly one acquires the org's lock", async () => {
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      const [ra] = await a.unsafe(lockKey(ORG_A));
      const [rb] = await b.unsafe(lockKey(ORG_A));
      expect(ra.got).toBe(true);
      expect(rb.got).toBe(false);
    } finally {
      await a.unsafe("select pg_advisory_unlock_all()");
      await b.unsafe("select pg_advisory_unlock_all()");
      a.release();
      b.release();
    }
  });

  test("the route refuses a start while the org lock is held, then accepts one", async ({
    request,
  }) => {
    const conn = await sql.reserve();
    try {
      const [held] = await conn.unsafe(lockKey(ORG_A));
      expect(held.got, "test could not hold the org lock").toBe(true);

      const refused = await request.post("/api/ingestion/run", {
        headers: authed(),
        data: { org_id: ORG_A },
      });
      expect(refused.status()).toBe(409);
      const body = (await refused.json()) as { error: string; reason: string };
      expect(body.error).toBe("run_in_progress");
      expect(body.reason).toBe("advisory_lock_busy");
    } finally {
      await conn.unsafe("select pg_advisory_unlock_all()");
      conn.release();
    }

    // Lock released: the same trigger now starts a run.
    const accepted = await request.post("/api/ingestion/run", {
      headers: authed(),
      data: { org_id: ORG_A },
    });
    const acceptedBody = (await accepted.json()) as { run_id?: string; reason?: string };
    expect(accepted.status(), JSON.stringify(acceptedBody)).toBe(200);
    expect(acceptedBody.run_id).toBeTruthy();
  });
});

test.describe("the one-running-per-org index (AC-03)", () => {
  test("a second 'running' row for an org is rejected by the partial unique index", async () => {
    const marker = `lock-idx-${randomUUID()}`;
    const secondMarker = `second-${marker}`;
    await sql`
      insert into pipeline_runs (org_id, source, kind, status, correlation_id)
      values (${ORG_A}, 'mock-provider', 'webhook', 'running', ${marker})`;

    await expect(
      sql`
        insert into pipeline_runs (org_id, source, kind, status, correlation_id)
        values (${ORG_A}, 'mock-provider', 'webhook', 'running', ${secondMarker})`,
    ).rejects.toThrow(/duplicate key|unique constraint/);

    // Clean up even when the assertion above fails: a leftover 'running' row
    // would block the next test's fixtures via the same index.
    await sql`delete from pipeline_runs where correlation_id in (${marker}, ${secondMarker})`;
  });

  test("the route refuses a start while a run is already running, then accepts one", async ({
    request,
  }) => {
    const marker = `lock-running-${randomUUID()}`;
    await sql`
      insert into pipeline_runs (org_id, source, kind, status, correlation_id)
      values (${ORG_A}, 'mock-provider', 'webhook', 'running', ${marker})`;

    const refused = await request.post("/api/ingestion/run", {
      headers: authed(),
      data: { org_id: ORG_A },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { reason?: string }).reason).toBe("already_running");

    await sql`delete from pipeline_runs where correlation_id = ${marker}`;

    const accepted = await request.post("/api/ingestion/run", {
      headers: authed(),
      data: { org_id: ORG_A },
    });
    expect(accepted.status()).toBe(200);
  });
});