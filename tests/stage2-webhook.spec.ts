import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ORG_A, sql } from "./helpers/db";
import { localStack, webhookSecret } from "./helpers/stack";
import { signRequest } from "@/platform/signing";

// The provider-webhook Edge Function — the push half of Stage 2 ingestion
// (PRD US-05). Stage 1's mock provider only exposes a pull API, so the push
// path has no upstream to trigger it; this spec is that upstream.
//
// What it is really guarding is code reuse. The function imports
// src/features/ingestion/transform.ts and calls the same ingest_raw_event routine the
// polling route calls, so idempotency and validation are proven once instead
// of reimplemented. Reuse that is only structural — the same import, subtly
// different behaviour — would still pass a reading of the code, so the same
// three outcomes the polling path guarantees are asserted here directly:
// written, duplicate, quarantined.
//
// Requires the local stack (`task dev-up`), which serves Edge Functions from
// its own container, with WEBHOOK_SHARED_SECRET reaching it through
// config.toml's [edge_runtime.secrets] — see docs/RUNBOOK.md.

test.describe.configure({ mode: "serial" });

// Everything this file writes, removed afterwards.
//
// Not tidiness. Stage 3's reconciliation is tenant-wide by design — it asks
// whether the tenant's ledger matches the provider's, which is not a
// per-run question — and it holds because every other invoice for this org
// came from the provider, so the provider counts it. These do not: the mock
// provider has no push API (a limitation PROGRESS.md records), so this spec
// has to fabricate the upstream, and what it fabricates has no counterpart
// in /summary. Left behind, the accepted invoice and the quarantined event
// — whose payload still carries a readable amount, so it counts as
// *accounted* just as much — push drift to +1.907% and turn a healthy
// reconciliation red. Fabricating the upstream is right; not cleaning up
// after it is the defect.
test.afterAll(async () => {
  const like = `inv-${tag}%`;
  // Child rows first: invoices and quarantine both reference raw_events,
  // and everything references pipeline_runs.
  await sql`delete from invoices where org_id = ${ORG_A} and external_id like ${like}`;
  await sql`
    delete from quarantine q
     using raw_events e
     where q.raw_event_id = e.id and e.org_id = ${ORG_A} and e.external_id like ${like}`;
  await sql`delete from raw_events where org_id = ${ORG_A} and external_id like ${like}`;
  // The runs this spec opened, identified by having nothing left to point
  // at them: every webhook run here wrote exactly one of the rows above.
  await sql`
    delete from pipeline_runs r
     where r.org_id = ${ORG_A} and r.kind = 'webhook'
       and not exists (select 1 from raw_events e where e.run_id = r.id)`;
});

interface WebhookResult {
  status?: "succeeded" | "duplicate" | "quarantined";
  run_id?: string;
  raw_event_id?: number;
  quarantine_reason?: string | null;
  error?: string;
}

// One tag per run of this file, so case 1 is a genuinely new record and case
// 2 a genuine redelivery of it. A fixed external_id would make the second
// execution of the file report "duplicate" for what should be a fresh write.
const tag = `wh-${Date.now()}`;
const goodId = `inv-${tag}`;
const badId = `inv-${tag}-null-customer`;

function event(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    external_id: externalId,
    customer: "Acme Corp",
    amount: 4999,
    currency: "USD",
    status: "open",
    issued_at: "2026-08-15",
    ...overrides,
  };
}

/**
 * Posts to the function through the API gateway.
 *
 * Two credentials, doing two different jobs: the gateway checks the anon key
 * before routing at all, and the function verifies an HMAC signature over the
 * exact body bytes before it writes anything (D-19 — it used to accept a
 * static header secret, which a captured request could replay forever).
 * `secret` is a parameter precisely so the second one can be tested
 * independently of the first.
 *
 * The body is serialized here rather than handed to Playwright as an object,
 * because the signature covers bytes: re-serializing would sign one string and
 * send another.
 */
async function post(
  request: APIRequestContext,
  body: unknown,
  opts: { secret?: string; correlationId?: string } = {},
): Promise<APIResponse> {
  const { functionsUrl, anonKey } = localStack();
  const rawBody = JSON.stringify(body);
  const signed = await signRequest(opts.secret ?? webhookSecret(), rawBody);
  return request.post(`${functionsUrl}/provider-webhook`, {
    headers: {
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      ...signed,
      ...(opts.correlationId ? { "x-correlation-id": opts.correlationId } : {}),
    },
    data: rawBody,
    // Playwright would otherwise throw on a 4xx before the test can assert it.
    failOnStatusCode: false,
  });
}

async function runCountFor(correlationId: string): Promise<number> {
  const [{ count }] = await sql`
    select count(*)::int from pipeline_runs where correlation_id = ${correlationId}`;
  return count;
}

test.describe("provider-webhook", () => {
  test("accepts a valid event and writes an invoice", async ({ request }) => {
    const correlationId = randomUUID();
    const res = await post(request, { org_id: ORG_A, event: event(goodId) }, { correlationId });
    expect(res.status(), await res.text()).toBe(200);

    const body = (await res.json()) as WebhookResult;
    expect(body.status).toBe("succeeded");

    // Positive control for the two "writes nothing" tests below. They assert
    // that no pipeline_runs row carries the correlation id they sent, which
    // would also hold if the header were ignored outright. This proves the
    // header does reach the row, so a zero there means a run was not opened.
    expect(await runCountFor(correlationId), "the correlation id never reached the run").toBe(1);

    const rows = await sql`
      select amount_cents, currency from invoices
       where org_id = ${ORG_A} and external_id = ${goodId}`;
    expect(rows).toHaveLength(1);
    // The provider sends a decimal amount; the shared transform is what turns
    // it into integer cents, so this asserts the reuse rather than the number.
    // bigint arrives as a string from postgres.js.
    expect(Number(rows[0].amount_cents)).toBe(499900);
  });

  test("records the run as kind='webhook'", async () => {
    // Not 'incremental'. The polling path resumes from the newest succeeded
    // incremental run's cursor_to, so a cursorless webhook run filed under
    // that kind resets the poller to offset 0 and re-reads the whole dataset.
    const rows = await sql`
      select r.kind from pipeline_runs r
        join raw_events e on e.run_id = r.id
       where e.org_id = ${ORG_A} and e.external_id = ${goodId}`;
    // Asserted before indexing: a zero-row result should name the missing
    // row, not throw "cannot read properties of undefined".
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("webhook");
  });

  test("deduplicates a redelivery without writing a second invoice", async ({ request }) => {
    // At-least-once delivery is the norm for webhooks, so this is the case
    // that actually happens in production, not an edge case.
    const res = await post(request, { org_id: ORG_A, event: event(goodId) });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as WebhookResult).status).toBe("duplicate");

    const [{ count }] = await sql`
      select count(*)::int from invoices
       where org_id = ${ORG_A} and external_id = ${goodId}`;
    expect(count, "a redelivery created a second invoice").toBe(1);
  });

  test("quarantines an invalid event instead of dropping it", async ({ request }) => {
    const res = await post(request, {
      org_id: ORG_A,
      event: event(badId, { customer: null }),
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as WebhookResult;
    expect(body.status).toBe("quarantined");
    expect(body.quarantine_reason).toContain("schema_validation_failed");

    // US-04: a record the pipeline cannot use is still a record it kept.
    const rows = await sql`
      select q.reason from quarantine q
        join raw_events e on e.id = q.raw_event_id
       where e.org_id = ${ORG_A} and e.external_id = ${badId}`;
    expect(rows).toHaveLength(1);
    const [{ count: invoiced }] = await sql`
      select count(*)::int from invoices
       where org_id = ${ORG_A} and external_id = ${badId}`;
    expect(invoiced).toBe(0);
  });

  test("rejects a wrong secret and writes nothing at all", async ({ request }) => {
    const correlationId = randomUUID();
    const res = await post(request, { org_id: ORG_A, event: event(`inv-${tag}-forged`) }, {
      secret: "not-the-shared-secret",
      correlationId,
    });
    expect(res.status()).toBe(401);
    expect(((await res.json()) as WebhookResult).error).toBe("unauthorized");

    // Nothing happened, so there is nothing to record — an unauthorized call
    // must not leave a pipeline_runs row behind. Keyed on the correlation id
    // this request carried, which is the only thing tying a row to this call.
    expect(await runCountFor(correlationId), "an unauthorized call opened a run").toBe(0);
  });

  test("rejects a malformed body before opening a run", async ({ request }) => {
    // Validation happens before the first write for the same reason the auth
    // check does. An earlier arrangement opened the run first and then marked
    // it failed, which left the pipeline_runs table describing work that was
    // never attempted.
    const cases: { label: string; body: unknown; expected: string }[] = [
      { label: "org_id not a uuid", body: { org_id: "acme", event: event("x") },
        expected: "org_id must be a uuid" },
      { label: "event missing", body: { org_id: ORG_A },
        expected: "malformed_body: event required" },
      { label: "external_id missing", body: { org_id: ORG_A, event: { customer: "Acme Corp" } },
        expected: "malformed_body: event.external_id required" },
    ];

    for (const c of cases) {
      const correlationId = randomUUID();
      const res = await post(request, c.body, { correlationId });
      expect(res.status(), `${c.label}: ${await res.text()}`).toBe(400);
      expect(((await res.json()) as WebhookResult).error, c.label).toBe(c.expected);
      expect(await runCountFor(correlationId), `${c.label} opened a run`).toBe(0);
    }
  });
});
