import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ORG_A, sql } from "./helpers/db";
import { localStack, webhookSecret } from "./helpers/stack";

// D-15: the `futureDates` chaos flag produces invoices dated up to 30 days
// ahead. The format-only Zod check passed them as valid data, quietly
// inflating every metric. The transform now quarantines a future-dated
// invoice with a reason — AC-03: it lands in quarantine, never in invoices.
//
// Delivered through the provider-webhook Edge Function (HMAC-signed per
// D-19), which exercises the same shared transform the polling route uses.
//
// Requires the local stack (`task dev-up`), same as tests/stage2-webhook.spec.ts.

test.describe.configure({ mode: "serial" });

const tag = `wh-future-${Date.now()}`;
const usedNonces: string[] = [];

test.afterAll(async () => {
  const like = `inv-${tag}%`;
  await sql`delete from invoices where org_id = ${ORG_A} and external_id like ${like}`;
  await sql`
    delete from quarantine q
     using raw_events e
     where q.raw_event_id = e.id and e.org_id = ${ORG_A} and e.external_id like ${like}`;
  await sql`delete from raw_events where org_id = ${ORG_A} and external_id like ${like}`;
  await sql`
    delete from pipeline_runs r
     where r.org_id = ${ORG_A} and r.kind = 'webhook'
       and not exists (select 1 from raw_events e where e.run_id = r.id)`;
  if (usedNonces.length > 0) {
    await sql`delete from signed_request_nonces where nonce = any(${usedNonces})`;
  }
});

const VERSION = "v1";

function sign(secret: string, timestampMs: number, nonce: string, rawBody: string): string {
  return createHmac("sha256", secret)
    .update(`${VERSION}:${timestampMs}:${nonce}:${rawBody}`)
    .digest("hex");
}

function utcDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

function event(externalId: string, issuedAt: string) {
  return {
    external_id: externalId,
    customer: "Acme Corp",
    amount: 4999,
    currency: "USD",
    status: "open",
    issued_at: issuedAt,
  };
}

async function post(request: APIRequestContext, body: unknown): Promise<APIResponse> {
  const { functionsUrl, anonKey } = localStack();
  const rawBody = JSON.stringify(body);
  const timestampMs = Date.now();
  const nonce = randomUUID();
  usedNonces.push(nonce);
  return request.post(`${functionsUrl}/provider-webhook`, {
    headers: {
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      "x-webhook-timestamp": String(timestampMs),
      "x-webhook-nonce": nonce,
      "x-webhook-signature": sign(webhookSecret(), timestampMs, nonce, rawBody),
    },
    data: rawBody,
    failOnStatusCode: false,
  });
}

interface WebhookResult {
  status?: "succeeded" | "duplicate" | "quarantined";
  quarantine_reason?: string | null;
  error?: string;
}

test.describe("future-dated invoices", () => {
  test("quarantines a future-dated invoice instead of writing it (AC-03)", async ({ request }) => {
    const externalId = `inv-${tag}-tomorrow`;
    const res = await post(request, { org_id: ORG_A, event: event(externalId, utcDate(1)) });
    expect(res.status(), await res.text()).toBe(200);

    const body = (await res.json()) as WebhookResult;
    expect(body.status).toBe("quarantined");
    expect(body.quarantine_reason).toContain("future_dated");

    const rows = await sql`
      select q.reason from quarantine q
        join raw_events e on e.id = q.raw_event_id
       where e.org_id = ${ORG_A} and e.external_id = ${externalId}`;
    expect(rows, "the future-dated record never reached quarantine").toHaveLength(1);
    expect(rows[0].reason).toContain("future_dated");

    const [{ count: invoiced }] = await sql`
      select count(*)::int from invoices
       where org_id = ${ORG_A} and external_id = ${externalId}`;
    expect(invoiced, "a future-dated invoice landed in invoices").toBe(0);
  });

  test("accepts an invoice dated today (positive control)", async ({ request }) => {
    const externalId = `inv-${tag}-today`;
    const res = await post(request, { org_id: ORG_A, event: event(externalId, utcDate(0)) });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as WebhookResult).status).toBe("succeeded");

    const rows = await sql`
      select issued_at from invoices
       where org_id = ${ORG_A} and external_id = ${externalId}`;
    expect(rows, "a today-dated invoice was not written").toHaveLength(1);
    // postgres.js returns the date column as a JS Date at UTC midnight.
    expect((rows[0].issued_at as Date).toISOString().slice(0, 10)).toBe(utcDate(0));
  });
});
