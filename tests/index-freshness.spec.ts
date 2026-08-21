import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { renderInvoice } from "@/features/rag/chunk";
import { ingest } from "./helpers/api";
import { ORG_A, sql } from "./helpers/db";

// Spec 0003 (lane W2-B), AC-05 (D-14): the corpus index must not quietly go
// stale relative to the newest invoice.
//
// The loop is driven end to end:
//   1. red  - a freshly ingested invoice has no chunk yet, and
//             public.corpus_index_freshness() reports 'stale';
//   2. the schedule notices - firing the ll_reindex cron job's command
//      enqueues a pending reindex marker (idempotently);
//   3. green - a consumer of that marker writes the missing chunk (the same
//      shape the indexer CLI and the Python indexer produce) and freshness
//      flips to 'fresh'.
//
// The green step writes the chunk directly instead of invoking the indexer:
// embedding goes through the Edge Function, whose D-19 HMAC migration (lane
// W2-E, mid-wave) currently rejects the app-side caller's unsigned requests
// - a known cross-lane dependency the parent wires at integration. This
// spec's subject is the freshness mechanism, so the consumer's write is
// performed as SQL (zero vector; embedding quality is Stage 5's concern).
//
// The fabricated invoice is written through the same atomic
// ingest_raw_event function the webhook path uses, with an external_id the
// provider will never emit, and is removed afterwards (same discipline as
// tests/stage2-webhook.spec.ts: the mock provider has no push API, so what
// this spec fabricates has no counterpart in /summary and would otherwise
// push the tenant's reconciliation drift).

test.describe.configure({ mode: "serial" });

const tag = `idx-${Date.now()}`;
const externalId = `inv-${tag}`;
const correlationId = `idx-run-${randomUUID()}`;

function runIndexer(): void {
  // stderr is captured, not discarded: the stage-5 rebuild flaked once and
  // stdio:"ignore" turned the reason into "Command failed".
  try {
    execFileSync("pnpm", ["exec", "tsx", "scripts/index-corpus.ts", "--org", ORG_A], {
      stdio: "pipe",
    });
  } catch (error) {
    const detail = error as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(
      `index-corpus failed:
${detail.stderr?.toString() ?? ""}
${detail.stdout?.toString() ?? ""}`,
    );
  }
}

interface Freshness {
  status: string;
  newest_invoice: string;
  newest_indexed: string;
}

async function freshness(): Promise<Freshness> {
  const rows = await sql`select * from public.corpus_index_freshness(${ORG_A})`;
  if (!rows[0]) throw new Error("corpus_index_freshness returned no row");
  return rows[0] as Freshness;
}

test.beforeAll(async ({ request }) => {
  // Rebuilding the index takes ~30s for one tenant (embedding through the
  // Edge Function, capped at 8 texts per call) - well past the default hook
  // timeout.
  test.setTimeout(300_000);

  // Own precondition: the corpus is seeded documents plus indexed invoices,
  // so invoices must exist before staleness can mean anything.
  const invoiceRows = await sql`select count(*)::int as n from invoices where org_id = ${ORG_A}`;
  if (invoiceRows[0].n === 0) await ingest(request, ORG_A);

  // Index only when the corpus is actually behind: an already-fresh corpus
  // needs no embedding calls at all (the Edge Function's D-19 migration is
  // mid-wave; see the header note), and the stale-state baseline below is
  // what the tests actually assert against.
  const baseline = await freshness();
  if (baseline.status === "stale") runIndexer();

  // Fresh slate for this org's markers so the "the schedule noticed" step
  // counts only this spec's fire (scheduled_runs is this lane's table).
  await sql`delete from scheduled_runs where org_id = ${ORG_A}`;
});

test.afterAll(async () => {
  // Child rows first: the invoice's chunk cascades on delete; the raw event
  // is the invoice's parent; the run is the raw event's parent.
  await sql`delete from invoices where org_id = ${ORG_A} and external_id = ${externalId}`;
  await sql`delete from raw_events where org_id = ${ORG_A} and external_id = ${externalId}`;
  await sql`delete from pipeline_runs where correlation_id = ${correlationId}`;
});

test.describe("corpus index freshness (D-14, AC-05)", () => {
  test("a newly ingested invoice leaves the index stale (the red test)", async () => {
    const runs = await sql`
      insert into pipeline_runs (org_id, source, kind, status, correlation_id)
      values (${ORG_A}, 'mock-provider', 'webhook', 'succeeded', ${correlationId})
      returning id`;

    const payload = JSON.stringify({
      external_id: externalId,
      customer: "Acme Corp",
      amount: 1234.56,
      currency: "USD",
      status: "open",
      issued_at: "2026-08-21",
    });

    const ingested = await sql`
      select * from public.ingest_raw_event(
        p_org_id := ${ORG_A},
        p_source := 'mock-provider',
        p_external_id := ${externalId},
        p_event_version := '1',
        p_payload := ${payload},
        p_payload_hash := 'freshness-test',
        p_run_id := ${runs[0].id},
        p_pipeline_version := '1',
        p_customer := 'Acme Corp',
        p_amount_cents := 123456,
        p_currency := 'USD',
        p_status := 'open',
        p_issued_at := '2026-08-21',
        p_quarantine_reason := null,
        p_quarantine_details := null
      )`;
    expect(ingested[0]?.outcome, "the fabricated invoice was not written").toBe("written");

    const chunkRows = await sql`
      select count(*)::int as n from chunks c
        join invoices i on i.id = c.invoice_id
       where i.org_id = ${ORG_A} and i.external_id = ${externalId}`;
    expect(chunkRows[0].n, "a fresh invoice should have no chunk yet").toBe(0);

    const state = await freshness();
    expect(state.status, JSON.stringify(state)).toBe("stale");
    expect(new Date(state.newest_invoice).getTime()).toBeGreaterThan(
      new Date(state.newest_indexed).getTime(),
    );
  });

  test("firing the reindex schedule enqueues the reindex marker", async () => {
    const jobs = await sql`select command from cron.job where jobname = 'll_reindex'`;
    expect(jobs[0], "ll_reindex missing from cron.job").toBeTruthy();

    await sql.unsafe(jobs[0].command);
    const markers = await sql`
      select id from scheduled_runs
       where org_id = ${ORG_A} and kind = 'reindex' and status = 'pending'`;
    expect(markers[0], "no pending reindex marker after firing the schedule").toBeTruthy();

    // Idempotent: a second fire reuses the pending marker.
    await sql.unsafe(jobs[0].command);
    const counts = await sql`
      select count(*)::int as n from scheduled_runs
       where org_id = ${ORG_A} and kind = 'reindex' and status = 'pending'`;
    expect(counts[0].n).toBe(1);
  });

  test("a consumer writing the missing chunk turns freshness green", async () => {
    // The reindex consumer's effect: the invoice that made the corpus stale
    // now has a chunk. Written as SQL (the indexer CLI / Python indexer
    // produce the same row shape through their own embed path).
    const invoices = await sql`
      select id, external_id, customer, amount_cents, currency, status, issued_at, paid_at
        from invoices where org_id = ${ORG_A} and external_id = ${externalId}`;
    expect(invoices[0], "the fabricated invoice is gone").toBeTruthy();

    const content = renderInvoice(
      invoices[0] as unknown as {
        external_id: string;
        customer: string;
        amount_cents: number;
        currency: string;
        status: string;
        issued_at: string;
        paid_at: string | null;
      },
    );
    await sql`
      insert into chunks (org_id, invoice_id, chunk_no, content, content_hash,
                          embedding, embedding_model, updated_at)
      values (${ORG_A}, ${invoices[0].id}, 0, ${content}, 'freshness-test-hash',
              array_fill(0::real, array[384])::extensions.vector,
              'gte-small', now())`;

    const chunkRows = await sql`
      select count(*)::int as n from chunks c
        join invoices i on i.id = c.invoice_id
       where i.org_id = ${ORG_A} and i.external_id = ${externalId}`;
    expect(chunkRows[0].n, "the consumer's chunk was not written").toBe(1);

    const state = await freshness();
    expect(state.status, JSON.stringify(state)).toBe("fresh");
  });
});