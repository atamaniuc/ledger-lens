import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ORG_A, sql } from "./helpers/db";
import { localStack, webhookSecret } from "./helpers/stack";

// D-19: the provider-webhook Edge Function authenticates with HMAC-SHA256
// over `v1:<timestamp>:<nonce>:<rawBody>`, compared in constant time, with a
// freshness window and a single-use nonce held in Postgres. The previous
// static x-webhook-secret header let anyone who captured one request replay
// it forever; these tests prove the replacement rejects a replay, a stale
// timestamp, and a reused nonce — before anything is written.
//
// The spec name is the acceptance criterion (AC-01/AC-02): the identical
// signed request delivered twice must be rejected the second time.
//
// Requires the local stack (`task dev-up`), same as tests/stage2-webhook.spec.ts.

test.describe.configure({ mode: "serial" });

// Everything this file writes, removed afterwards (same discipline as
// tests/stage2-webhook.spec.ts: fabricated events have no counterpart in
// the provider's /summary, so leftovers break Stage 3 reconciliation).
const tag = `wh-hmac-${Date.now()}`;
const goodId = `inv-${tag}`;
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

interface PostOpts {
  /** Override the signature header entirely (e.g. a bad one). */
  signature?: string;
  /** Override the timestamp header (e.g. a stale one). */
  timestampMs?: number;
  /** Override the nonce header. */
  nonce?: string;
  /** Override the secret used to compute the signature. */
  secret?: string;
  /** Drop the named headers entirely. */
  omit?: ("timestamp" | "nonce" | "signature")[];
  correlationId?: string;
}

interface SignedEnvelope {
  headers: Record<string, string>;
  rawBody: string;
}

/**
 * Builds one signed request: the body signed as the exact string sent on
 * the wire (the function signs raw bytes, so the request must send the
 * same serialization that was signed). A replay test needs the *identical*
 * envelope twice, so building is separated from delivering.
 */
function buildSignedRequest(body: unknown, opts: PostOpts = {}): SignedEnvelope {
  const { anonKey } = localStack();
  const secret = opts.secret ?? webhookSecret();
  const rawBody = JSON.stringify(body);
  const timestampMs = opts.timestampMs ?? Date.now();
  const nonce = opts.nonce ?? randomUUID();
  usedNonces.push(nonce);

  const headers: Record<string, string> = {
    authorization: `Bearer ${anonKey}`,
    "content-type": "application/json",
    ...(opts.correlationId ? { "x-correlation-id": opts.correlationId } : {}),
  };
  if (!opts.omit?.includes("timestamp")) headers["x-webhook-timestamp"] = String(timestampMs);
  if (!opts.omit?.includes("nonce")) headers["x-webhook-nonce"] = nonce;
  if (!opts.omit?.includes("signature")) {
    headers["x-webhook-signature"] = opts.signature ?? sign(secret, timestampMs, nonce, rawBody);
  }
  return { headers, rawBody };
}

async function post(
  request: APIRequestContext,
  body: unknown,
  opts: PostOpts = {},
): Promise<APIResponse> {
  const { functionsUrl } = localStack();
  const envelope = buildSignedRequest(body, opts);
  return request.post(`${functionsUrl}/provider-webhook`, {
    headers: envelope.headers,
    data: envelope.rawBody,
    // Playwright would otherwise throw on a 4xx before the test can assert it.
    failOnStatusCode: false,
  });
}

async function postEnvelope(
  request: APIRequestContext,
  envelope: SignedEnvelope,
): Promise<APIResponse> {
  const { functionsUrl } = localStack();
  return request.post(`${functionsUrl}/provider-webhook`, {
    headers: envelope.headers,
    data: envelope.rawBody,
    failOnStatusCode: false,
  });
}

interface WebhookResult {
  status?: "succeeded" | "duplicate" | "quarantined";
  run_id?: string;
  error?: string;
}

async function runCountFor(correlationId: string): Promise<number> {
  const [{ count }] = await sql`
    select count(*)::int from pipeline_runs where correlation_id = ${correlationId}`;
  return count;
}

test.describe("provider-webhook HMAC auth", () => {
  test("accepts a valid signed request", async ({ request }) => {
    const res = await post(request, { org_id: ORG_A, event: event(goodId) });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as WebhookResult).status).toBe("succeeded");

    const rows = await sql`
      select amount_cents from invoices
       where org_id = ${ORG_A} and external_id = ${goodId}`;
    expect(rows).toHaveLength(1);
  });

  test("rejects the identical signed request delivered twice (AC-01)", async ({ request }) => {
    const body = { org_id: ORG_A, event: event(`inv-${tag}-replay`) };
    // One envelope — same body bytes, same timestamp, same nonce, same
    // signature — delivered twice. The nonce store must reject the second
    // delivery before anything is written.
    const envelope = buildSignedRequest(body, { correlationId: randomUUID() });

    const first = await postEnvelope(request, envelope);
    expect(first.status(), await first.text()).toBe(200);

    const secondCorrelationId = randomUUID();
    const second = await postEnvelope(request, {
      ...envelope,
      headers: { ...envelope.headers, "x-correlation-id": secondCorrelationId },
    });
    expect(second.status(), await second.text()).toBe(401);
    expect(((await second.json()) as WebhookResult).error).toBe("unauthorized");
    expect(
      await runCountFor(secondCorrelationId),
      "a replayed request opened a run",
    ).toBe(0);
  });

  test("rejects an absent signature (AC-02)", async ({ request }) => {
    const res = await post(request, { org_id: ORG_A, event: event(`inv-${tag}-nosig`) }, {
      omit: ["signature"],
      correlationId: randomUUID(),
    });
    expect(res.status(), await res.text()).toBe(401);
    expect(((await res.json()) as WebhookResult).error).toBe("unauthorized");
  });

  test("rejects a bad signature (AC-02)", async ({ request }) => {
    const res = await post(request, { org_id: ORG_A, event: event(`inv-${tag}-badsig`) }, {
      signature: "a".repeat(64),
      correlationId: randomUUID(),
    });
    expect(res.status(), await res.text()).toBe(401);
    expect(((await res.json()) as WebhookResult).error).toBe("unauthorized");
  });

  test("rejects a signature computed with the wrong secret (AC-02)", async ({ request }) => {
    const res = await post(request, { org_id: ORG_A, event: event(`inv-${tag}-wrongsecret`) }, {
      secret: "not-the-shared-secret",
      correlationId: randomUUID(),
    });
    expect(res.status(), await res.text()).toBe(401);
    expect(((await res.json()) as WebhookResult).error).toBe("unauthorized");
  });

  test("rejects a stale timestamp (AC-02)", async ({ request }) => {
    // Ten minutes old — beyond the five-minute freshness window.
    const res = await post(request, { org_id: ORG_A, event: event(`inv-${tag}-stale`) }, {
      timestampMs: Date.now() - 10 * 60 * 1000,
      correlationId: randomUUID(),
    });
    expect(res.status(), await res.text()).toBe(401);
    expect(((await res.json()) as WebhookResult).error).toBe("unauthorized");
  });

  test("rejects a reused nonce even with a fresh timestamp (AC-01)", async ({ request }) => {
    const body = { org_id: ORG_A, event: event(`inv-${tag}-noncereuse`) };
    const nonce = randomUUID();

    const first = await post(request, body, { nonce });
    expect(first.status(), await first.text()).toBe(200);

    // Same nonce, fresh timestamp, freshly computed (valid) signature.
    const second = await post(request, body, { nonce });
    expect(second.status(), await second.text()).toBe(401);
    expect(((await second.json()) as WebhookResult).error).toBe("unauthorized");
  });

  test("rejects an oversized body", async ({ request }) => {
    const huge = { org_id: ORG_A, event: event(`inv-${tag}-huge`, { pad: "x".repeat(2 * 1024 * 1024) }) };
    const res = await post(request, huge, { correlationId: randomUUID() });
    expect(res.status(), await res.text()).toBe(413);
    expect(((await res.json()) as WebhookResult).error).toBe("body_too_large");
  });
});
