// Draft for the PARENT lane — move this to tests/transcribe-idempotency.spec.ts.
// Spec 0009 (D-42) acceptance criteria, machine-checked against the live
// stack exactly like tests/stage2-webhook.spec.ts and
// tests/webhook-replay.spec.ts (which this mirrors). Requires the local
// stack with migration 20260821150000_transcripts.sql applied and the
// transcribe-webhook Edge Function served.
//
// AC-01  signed webhook produces a timestamped transcript ingested into
//        raw_events + documents, through the same transform/quarantine path
// AC-02  the same audio twice -> one transcript (idempotency on content)
// AC-03  malformed transcript / impossible date -> quarantine with a reason
// AC-04  the webhook requires signed-webhook auth (HMAC + timestamp + nonce,
//        replay refused)

import { createHash, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ORG_B, sql } from "./helpers/db";
import { localStack, webhookSecret } from "./helpers/stack";
import { signRequest } from "@/platform/signing";

test.describe.configure({ mode: "serial" });

const tag = `tr-${Date.now()}`;
const usedNonces: string[] = [];
// Everything this file writes is removed afterwards, and the runs it opened are
// bounded by when it started rather than by a tag — a pipeline_runs row carries
// no external_id to match on.
const startedAt = new Date().toISOString();

test.afterAll(async () => {
  const like = `%${tag}%`;
  await sql`delete from documents d using raw_events e where d.raw_event_id = e.id and e.org_id = ${ORG_B} and e.external_id like ${like}`;
  await sql`
    delete from quarantine q using raw_events e
     where q.raw_event_id = e.id and e.org_id = ${ORG_B} and e.external_id like ${like}`;
  await sql`delete from raw_events where org_id = ${ORG_B} and external_id like ${like}`;
  await sql`
    delete from pipeline_runs r
     where r.org_id = ${ORG_B} and r.source = 'transcription' and r.started_at >= ${startedAt}`;
  if (usedNonces.length > 0) {
    await sql`delete from signed_request_nonces where nonce = any(${usedNonces})`;
  }
});

function event(audioHash: string, overrides: Record<string, unknown> = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    audio_hash: audioHash,
    recorded_at: today,
    duration_seconds: 5.0,
    model: "stub-whisper",
    transcript: {
      text: "Good morning. Thank you for coming in today.",
      language: "en",
      segments: [
        { start: 0.0, end: 2.0, text: "Good morning." },
        { start: 2.0, end: 5.0, text: "Thank you for coming in today." },
      ],
    },
    ...overrides,
  };
}

function audioHash(seed: string): string {
  return createHash("sha256").update(`audio-${seed}`).digest("hex");
}

interface WebhookResult {
  status?: "succeeded" | "duplicate" | "quarantined";
  run_id?: string;
  raw_event_id?: number;
  quarantine_reason?: string | null;
  error?: string;
}

async function post(
  request: APIRequestContext,
  body: unknown,
  opts: { secret?: string; correlationId?: string } = {},
): Promise<APIResponse> {
  const { functionsUrl, anonKey } = localStack();
  const rawBody = JSON.stringify(body);
  const signed = await signRequest(opts.secret ?? webhookSecret(), rawBody);
  usedNonces.push(signed["x-webhook-nonce"]);
  return request.post(`${functionsUrl}/transcribe-webhook`, {
    headers: {
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      ...signed,
      ...(opts.correlationId ? { "x-correlation-id": opts.correlationId } : {}),
    },
    data: rawBody,
    failOnStatusCode: false,
  });
}

test.describe("transcribe-webhook", () => {
  const goodHash = audioHash(`good-${tag}`);

  test("AC-01: accepts a signed timestamped transcript into raw_events and documents", async ({ request }) => {
    const res = await post(request, { org_id: ORG_B, event: event(goodHash) }, { correlationId: `corr-${tag}-1` });
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as WebhookResult).status).toBe("succeeded");

    const rows = await sql`
      select d.kind, e.source, e.external_id, (d.run_id is not null) as has_run_id,
             (d.raw_event_id is not null) as has_raw_id, r.kind as run_kind
        from documents d
        join raw_events e on e.id = d.raw_event_id
        join pipeline_runs r on r.id = e.run_id
       where e.org_id = ${ORG_B} and e.external_id = ${goodHash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "transcript",
      source: "transcription",
      external_id: goodHash,
      has_run_id: true,
      has_raw_id: true,
      run_kind: "webhook",
    });
  });

  test("AC-02: the same audio twice produces one transcript (idempotency on content)", async ({ request }) => {
    const first = await post(request, { org_id: ORG_B, event: event(goodHash) });
    expect(first.status(), await first.text()).toBe(200);
    expect(((await first.json()) as WebhookResult).status).toBe("duplicate");

    const [{ count }] = await sql`
      select count(*)::int from documents d
        join raw_events e on e.id = d.raw_event_id
       where e.org_id = ${ORG_B} and e.external_id = ${goodHash}`;
    expect(count, "a redelivery created a second transcript document").toBe(1);
  });

  test("AC-03: an impossible (future) recorded_at quarantines with a reason", async ({ request }) => {
    const futureHash = audioHash(`future-${tag}`);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await post(request, { org_id: ORG_B, event: event(futureHash, { recorded_at: tomorrow }) });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as WebhookResult;
    expect(body.status).toBe("quarantined");
    expect(body.quarantine_reason).toContain("future_dated");

    const [{ count }] = await sql`
      select count(*)::int from quarantine q
        join raw_events e on e.id = q.raw_event_id
       where e.org_id = ${ORG_B} and e.external_id = ${futureHash}`;
    expect(count).toBe(1);
  });

  test("AC-03: malformed transcript content quarantines with a reason", async ({ request }) => {
    const emptyHash = audioHash(`empty-${tag}`);
    const res = await post(request, {
      org_id: ORG_B,
      event: event(emptyHash, { transcript: { text: "   ", language: "en", segments: [] } }),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as WebhookResult;
    expect(body.status).toBe("quarantined");
    expect(body.quarantine_reason).toContain("schema_validation_failed");
  });

  test("AC-04: refuses an unsigned callback and writes nothing", async ({ request }) => {
    const correlationId = randomUUID();
    const { functionsUrl, anonKey } = localStack();
    const res = await request.post(`${functionsUrl}/transcribe-webhook`, {
      headers: { authorization: `Bearer ${anonKey}`, "content-type": "application/json", "x-correlation-id": correlationId },
      data: JSON.stringify({ org_id: ORG_B, event: event(audioHash(`nosig-${tag}`)) }),
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(401);
    const [{ count }] = await sql`select count(*)::int from pipeline_runs where correlation_id = ${correlationId}`;
    expect(count, "an unauthorized call opened a run").toBe(0);
  });

  test("AC-04: rejects the identical signed request delivered twice (replay)", async ({ request }) => {
    const body = { org_id: ORG_B, event: event(audioHash(`replay-${tag}`)) };
    const { functionsUrl, anonKey } = localStack();
    const rawBody = JSON.stringify(body);
    const signed = await signRequest(webhookSecret(), rawBody);
    const headers = {
      authorization: `Bearer ${anonKey}`,
      "content-type": "application/json",
      ...signed,
    };
    usedNonces.push(signed["x-webhook-nonce"]);

    const first = await request.post(`${functionsUrl}/transcribe-webhook`, { headers, data: rawBody, failOnStatusCode: false });
    expect(first.status(), await first.text()).toBe(200);

    const secondCorrelationId = randomUUID();
    const second = await request.post(`${functionsUrl}/transcribe-webhook`, {
      headers: { ...headers, "x-correlation-id": secondCorrelationId },
      data: rawBody,
      failOnStatusCode: false,
    });
    expect(second.status(), await second.text()).toBe(401);
    const [{ count }] = await sql`select count(*)::int from pipeline_runs where correlation_id = ${secondCorrelationId}`;
    expect(count, "a replayed request opened a run").toBe(0);
  });

  test("AC-04: rejects a signature made with the wrong secret", async ({ request }) => {
    const res = await post(request, { org_id: ORG_B, event: event(audioHash(`badsecret-${tag}`)) }, {
      secret: "not-the-shared-secret",
    });
    expect(res.status(), await res.text()).toBe(401);
  });
});
