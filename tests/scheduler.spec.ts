import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ingest } from "./helpers/api";
import { ALICE, BOB, ORG_A, asUser, sql } from "./helpers/db";

// Spec 0003 (lane W2-B), AC-01/D-11 + D-13 + D-10:
//
//  * pg_cron is configured - "select * from cron.job" shows the three jobs
//    (ingest, quality, reindex), each with a real schedule and a command
//    that enqueues a scheduled_runs marker.
//  * "The schedule fires": pg_cron 1.6.4 has no cron.fire(), so each test
//    executes the job's own command text (the exact SQL the scheduler would
//    run) and asserts it produces a marker row with no human action and no
//    HTTP call. Firing twice is idempotent: the pending marker is reused
//    (at-least-once + dedup, the project's stated delivery semantics).
//  * Reap (D-13, polling half): try_start_polling_run reaps an abandoned
//    'running' row on the next start, before the one-running-per-org check.
//  * The new table carries RLS like everything else: a member sees their
//    own org's markers, a non-member sees nothing.
//  * D-10: the "Stage 4's cron" comment is gone from the ingestion route.
//
// The jobs are active with real schedules but only ever write markers into
// scheduled_runs - they never touch pipeline_runs, invoices or chunks - so
// the shared stack's other suites are unaffected by a fire landing between
// their assertions.

test.describe.configure({ mode: "serial" });

const tag = `sch-${Date.now()}`;

test.beforeAll(async () => {
  // Deterministic slate for this spec's org. scheduled_runs is this lane's
  // own table (no seeded rows), and the enqueue dedupe means at most one
  // pending marker per (org, kind) exists at any moment - even if a
  // background fire lands mid-test, the count below still holds.
  await sql`delete from scheduled_runs where org_id = ${ORG_A}`;
});

test.afterAll(async () => {
  // The abandoned-row fixture this spec creates for the reap test.
  await sql`delete from pipeline_runs where correlation_id like ${'stuck-run-' + tag + '%'}`;
});

test.describe("pg_cron scheduler (D-11, AC-01)", () => {
  test("cron.job shows the three jobs with real schedules", async () => {
    const jobs = await sql`
      select jobid, jobname, schedule, command, active
        from cron.job
       where jobname in ('ll_ingest', 'll_quality', 'll_reindex')
       order by jobname`;

    expect(jobs.map((j) => j.jobname)).toEqual(["ll_ingest", "ll_quality", "ll_reindex"]);

    const byName = new Map(jobs.map((j) => [j.jobname, j]));
    expect(byName.get("ll_ingest")?.schedule).toBe("*/15 * * * *");
    expect(byName.get("ll_quality")?.schedule).toBe("2-59/15 * * * *");
    expect(byName.get("ll_reindex")?.schedule).toBe("30 * * * *");
    for (const job of jobs) {
      expect(job.active, `${job.jobname} is not active`).toBe(true);
      expect(job.command).toContain("public.enqueue_scheduled_run");
    }
  });

  for (const [name, kind] of [
    ["ll_ingest", "ingest"],
    ["ll_quality", "quality"],
    ["ll_reindex", "reindex"],
  ] as const) {
    test(`firing ${name} produces a ${kind} run row with no human action`, async () => {
      const jobs = await sql`select command from cron.job where jobname = ${name}`;
      expect(jobs[0], `job ${name} missing from cron.job`).toBeTruthy();

      // The scheduler's own command, executed: the marker appears with no
      // HTTP call and no human trigger. enqueue_scheduled_run returns the
      // marker id, which is what makes the assertions below robust even if
      // the 15-minute background scheduler fires mid-test: dedupe keeps at
      // most one pending marker per (org, kind) either way.
      const fired = await sql.unsafe(jobs[0].command);
      const firstId = Number(fired[0].enqueue_scheduled_run);

      const markers = await sql`
        select id from scheduled_runs
         where org_id = ${ORG_A} and kind = ${kind} and status = 'pending'`;
      expect(markers.length, `firing ${name} produced no pending ${kind} marker`).toBe(1);
      expect(Number(markers[0].id)).toBe(firstId);

      // Idempotent: a second fire returns the same pending marker instead of
      // piling up duplicate work.
      const refired = await sql.unsafe(jobs[0].command);
      expect(Number(refired[0].enqueue_scheduled_run)).toBe(firstId);
    });
  }
});

test.describe("reap (D-13, polling half)", () => {
  test("the polling path reaps an abandoned run before starting", async ({ request }) => {
    const stuckId = randomUUID();
    // A leftover 'running' row from a prior failed test would violate the
    // one-running-per-org index on the insert below; fail any such rows
    // first (they are, by definition, not completing runs).
    await sql`
      update pipeline_runs set status = 'failed', finished_at = now()
       where org_id = ${ORG_A} and status = 'running'`;
    await sql`
      insert into pipeline_runs (id, org_id, source, kind, status, started_at, correlation_id)
      values (${stuckId}, ${ORG_A}, 'mock-provider', 'incremental', 'running',
              now() - interval '1 hour', 'stuck-run-' || ${tag} || '-' || ${stuckId})`;

    const run = await ingest(request, ORG_A);
    expect(run.status).toBe("succeeded");

    const rows = await sql`select status, error from pipeline_runs where id = ${stuckId}`;
    expect(rows[0].status, "the abandoned run was not reaped").toBe("failed");
    expect(rows[0].error).toContain("abandoned");
  });
});

test.describe("scheduled_runs RLS", () => {
  test("a member of the org sees its markers; a non-member sees nothing", async () => {
    await asUser(ALICE, async (tx) => {
      const rows = await tx`select id from scheduled_runs where org_id = ${ORG_A}`;
      expect(rows.length, "Alice (Acme) cannot see her org's markers").toBeGreaterThan(0);
    });

    await asUser(BOB, async (tx) => {
      const rows = await tx`select id from scheduled_runs where org_id = ${ORG_A}`;
      expect(rows, "Bob (Globex) can read Acme's markers").toHaveLength(0);
    });
  });
});

test.describe("D-10 - the promised scheduler exists", () => {
  test("the 'Stage 4's cron' comment is gone from the ingestion route", () => {
    const source = readFileSync("src/app/api/ingestion/run/route.ts", "utf8");
    expect(source).not.toContain("Stage 4's cron");
  });
});