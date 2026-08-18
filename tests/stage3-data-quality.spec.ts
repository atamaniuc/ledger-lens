import { expect, test } from "@playwright/test";
import { authed, check, checkQuality, ingest, type CheckRow } from "./helpers/api";
import { ORG_A, ORG_B, sql, whatIf } from "./helpers/db";
import type postgres from "postgres";

// Stage 3: four checks per run. Every one is asserted both ways — that it
// passes on healthy data, and that it can go red. A check that cannot fail
// is decoration.

test.describe.configure({ mode: "serial" });
let providerTotal: number;
let providerCount: number;

/**
 * Runs the checks against a database that has been mutated, then rolls the
 * mutation back. Returns the status of one named check.
 */
async function whatIfStatus(
  mutate: (tx: postgres.TransactionSql) => Promise<unknown>,
  name: CheckRow["check_name"],
): Promise<CheckRow["status"]> {
  return whatIf(async (tx) => {
    await mutate(tx);
    const [{ id: runId }] = await tx`
      select id from pipeline_runs
       where org_id = ${ORG_A} and kind = 'incremental'
       order by started_at desc limit 1`;
    const rows = await tx`
      select check_name, status from run_data_quality_checks(
        ${ORG_A}::uuid, ${runId}::uuid, ${providerTotal}::bigint, ${providerCount}::integer)`;
    const row = rows.find((r) => r.check_name === name);
    if (!row) throw new Error(`no '${name}' row in what-if result`);
    return row.status as CheckRow["status"];
  });
}

test.describe("Stage 3 — Data Quality & Reconciliation", () => {
  let run: Awaited<ReturnType<typeof ingest>>;

  test.beforeAll(async ({ request }) => {
    const summary = await (await request.get("/api/mock-provider/summary")).json();
    providerTotal = summary.total_amount_cents;
    providerCount = summary.invoice_count;
    await sql`
      update pipeline_runs set cursor_to = null
       where org_id = ${ORG_A} and kind = 'incremental'`;
  });

  test("an unauthenticated check trigger is rejected", async ({ request }) => {
    const res = await request.post("/api/data-quality/run", { data: { org_id: ORG_A } });
    expect(res.status()).toBe(401);
  });

  test("every ingestion run carries a complete verdict", async ({ request }) => {
    // US-05: every run gets a verdict, with no scheduler to deploy.
    run = await ingest(request, ORG_A);
    expect(run.data_quality, "the run returned no verdict").not.toBeNull();
    const verdict = run.data_quality!;

    // A short set means a check silently did not run — a different problem
    // from a check failing, and one that otherwise reads as a clean pass.
    expect(verdict.complete, JSON.stringify(verdict.results.map((r) => r.check_name))).toBe(true);
    expect(verdict.results).toHaveLength(4);
    expect(verdict.results.map((r) => r.check_name).sort())
      .toEqual(["freshness", "reconciliation", "uniqueness", "volume"]);
    expect(verdict.overall).toBe("pass");
  });

  test("reconciliation drift is exactly zero", async () => {
    // US-04, the number the project is built around. Every cent the
    // provider reported is either invoiced or accounted for in quarantine —
    // not "close enough", zero.
    const recon = check(run.data_quality!, "reconciliation");
    const details = recon.details as {
      invoiced_cents: number;
      quarantined_cents: number;
      unaccounted_rows: number;
    };

    expect(Number(recon.delta), JSON.stringify(recon)).toBe(0);
    expect(details.unaccounted_rows).toBe(0);
    // Stated as the identity rather than as a single number, so a failure
    // says which side moved.
    expect(Number(details.invoiced_cents) + Number(details.quarantined_cents))
      .toBe(Number(recon.expected));
    // And the naive framing really would have been red: comparing against
    // written invoices alone leaves the quarantined value unaccounted for.
    expect(Number(details.quarantined_cents)).toBeGreaterThan(0);
  });

  test("a fully deduplicated re-run is not a volume anomaly", async ({ request }) => {
    // The most ordinary thing this pipeline does. Measuring the baseline on
    // rows_written made it score -100% and fail.
    await sql`
      update pipeline_runs set cursor_to = null
       where org_id = ${ORG_A} and kind = 'incremental'`;
    const rerun = await ingest(request, ORG_A);

    expect(rerun.rows_written).toBe(0);
    const volume = check(rerun.data_quality!, "volume");
    // Asserted as an allow-list, not as "not fail": an absent status is not
    // a passing status, and a negated test goes green exactly when the check
    // stops running.
    expect(["pass", "warn"]).toContain(volume.status);
    expect(Number(check(rerun.data_quality!, "reconciliation").delta)).toBe(0);
  });

  test("checks with no run abstain on volume", async ({ request }) => {
    // Without a run there is no batch to size. Treating the absent run as a
    // zero-row batch failed volume on every ad-hoc invocation.
    const verdict = await checkQuality(request, ORG_A);
    expect(verdict.complete).toBe(true);
    const volume = check(verdict, "volume");
    expect(["pass", "warn"]).toContain(volume.status);
    expect((volume.details as { reason?: string }).reason).toBe("no_run_context");
  });

  test("freshness fails on 25-hour-old data", async () => {
    const status = await whatIfStatus(
      (tx) => tx`update raw_events set ingested_at = now() - interval '25 hours'
                  where org_id = ${ORG_A}`,
      "freshness",
    );
    expect(status).toBe("fail");
  });

  test("reconciliation fails when a record's value cannot be located", async () => {
    const status = await whatIfStatus(
      (tx) => tx`
        insert into quarantine (org_id, raw_event_id, run_id, reason)
        select ${ORG_A}, null, id, 'simulated' from pipeline_runs
         where org_id = ${ORG_A} order by started_at desc limit 1`,
      "reconciliation",
    );
    expect(status).toBe("fail");
  });

  test("reconciliation fails when value actually goes missing", async () => {
    const status = await whatIfStatus(
      (tx) => tx`delete from invoices
                  where id in (select id from invoices where org_id = ${ORG_A} limit 5)`,
      "reconciliation",
    );
    expect(status).toBe("fail");
  });

  test("a null amount in a quarantined payload counts as unaccounted", async () => {
    // `payload ? 'amount'` is true for JSON null; the cast then yields NULL
    // and sum() skips it, so the value vanished while the check reported
    // zero unaccounted rows — pointing its reader at the wrong cause.
    const status = await whatIfStatus(
      (tx) => tx`
        update raw_events set payload = jsonb_set(payload, '{amount}', 'null')
         where id = (select raw_event_id from quarantine
                      where org_id = ${ORG_A} and raw_event_id is not null limit 1)`,
      "reconciliation",
    );
    expect(status).toBe("fail");
  });

  test("a non-numeric amount is reported, not fatal to the whole check", async () => {
    // This used to raise `invalid input syntax for type numeric` and take
    // the entire quality run down. Corrupt payloads are what this pipeline
    // exists to receive; one must not be able to disable the check that
    // would report it.
    const status = await whatIfStatus(
      (tx) => tx`
        update raw_events set payload = jsonb_set(payload, '{amount}', '"not-a-number"')
         where id = (select raw_event_id from quarantine
                      where org_id = ${ORG_A} and raw_event_id is not null limit 1)`,
      "reconciliation",
    );
    expect(status).toBe("fail");
  });

  test("volume fails on a batch far below its baseline", async () => {
    // The baseline needs three prior succeeded runs before volume judges
    // anything, so they are synthesised inside the same rolled-back
    // transaction. Without them this measured insufficient_history and
    // passed for the wrong reason.
    const status = await whatIfStatus(async (tx) => {
      await tx`
        insert into pipeline_runs (org_id, source, kind, status, started_at, finished_at, rows_read)
        select ${ORG_A}, 'mock-provider', 'incremental', 'succeeded',
               now() - interval '1 day', now() - interval '1 day', 207
          from generate_series(1, 3)`;
      await tx`
        update pipeline_runs set rows_read = 20
         where id = (select id from pipeline_runs
                      where org_id = ${ORG_A} and kind = 'incremental'
                      order by started_at desc limit 1)`;
    }, "volume");
    expect(status).toBe("fail");
  });

  test("volume tolerates a batch just inside the band", async () => {
    const status = await whatIfStatus(async (tx) => {
      await tx`
        insert into pipeline_runs (org_id, source, kind, status, started_at, finished_at, rows_read)
        select ${ORG_A}, 'mock-provider', 'incremental', 'succeeded',
               now() - interval '1 day', now() - interval '1 day', 207
          from generate_series(1, 3)`;
      await tx`
        update pipeline_runs set rows_read = 104
         where id = (select id from pipeline_runs
                      where org_id = ${ORG_A} and kind = 'incremental'
                      order by started_at desc limit 1)`;
    }, "volume");
    expect(status).toBe("pass");
  });

  test("a run_id from another org is rejected, not silently rescoped", async () => {
    const [{ id: runId }] = await sql`
      select id from pipeline_runs where org_id = ${ORG_A} and kind = 'incremental'
       order by started_at desc limit 1`;
    await expect(
      sql`select * from run_data_quality_checks(
            ${ORG_B}::uuid, ${runId}::uuid, ${providerTotal}::bigint, ${providerCount}::integer)`,
    ).rejects.toThrow(/does not belong to org/);
  });
});
