// Deno Edge Function — provider push path for Stage 2 ingestion.
// Reuses src/features/ingestion/transform.ts and src/platform/hash.ts verbatim
// (relative-path import, Deno resolves local .ts natively — ADR 0002)
// so idempotency and validation are proven once, not reimplemented for
// the push path. See ADR 0003/0004 and the "Ingestion & Transform"
// entry in .claude/PRD.md (US-05).
//
// Auth (D-19): HMAC-SHA256 over `v1:<timestamp>:<nonce>:<rawBody>`,
// compared in constant time, with a freshness window and a single-use
// nonce held in Postgres (public.consume_request_nonce). The previous
// static x-webhook-secret header let anyone who captured one request
// replay it forever; a replayed signature, an expired timestamp, or a
// reused nonce is now rejected before anything is read or written.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { validateInvoice } from "../../../src/features/ingestion/transform.ts";
import { hashPayload } from "../../../src/platform/hash.ts";
import {
  EVENT_VERSION,
  PIPELINE_VERSION,
  type IngestOutcome,
} from "../../../src/features/ingestion/constants.ts";
import {
  MAX_BODY_BYTES,
  NONCE_TTL_MS,
  checkRequestSignature,
  extractSignatureHeaders,
} from "../_shared/signature.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookBody {
  org_id: string;
  source?: string;
  event: unknown;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function failRun(supabase: SupabaseClient, runId: string, error: string) {
  const { error: updateError } = await supabase
    .from("pipeline_runs")
    .update({ status: "failed", finished_at: new Date().toISOString(), error })
    .eq("id", runId);
  if (updateError) console.error(JSON.stringify({ event: "run_close_failed", run_id: runId }));
}

Deno.serve(async (req: Request) => {
  // CLAUDE.md: every log line carries a correlation_id.
  const correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

  // Auth first — a rejected call writes nothing, not even a pipeline_runs
  // row: nothing happened, so there is nothing to record. The signature is
  // over the raw body bytes, so the body is read before anything else and
  // parsed only after auth.
  if (!WEBHOOK_SECRET) {
    log("webhook_unauthorized", { reason: "secret_unset" });
    return json({ error: "unauthorized" }, 401);
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    log("webhook_body_too_large", { bytes: rawBody.length });
    return json({ error: "body_too_large" }, 413);
  }

  const signatureCheck = await checkRequestSignature(
    extractSignatureHeaders(req),
    rawBody,
    WEBHOOK_SECRET,
  );
  if (!signatureCheck.ok) {
    log("webhook_unauthorized", { reason: signatureCheck.reason });
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // The replay half of D-19: the nonce is single-use. Only reached after
  // the signature verified, so an unauthenticated caller cannot populate
  // the store. False (or an error) means this exact signed request was
  // accepted before — fail closed.
  const { data: consumed, error: nonceError } = await supabase.rpc(
    "consume_request_nonce",
    {
      p_nonce: signatureCheck.nonce,
      p_expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    },
  );
  if (nonceError || consumed !== true) {
    log("webhook_nonce_rejected", {
      reason: nonceError?.message ?? "reused_nonce",
    });
    return json({ error: "unauthorized" }, 401);
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  // Everything the body must satisfy is checked *before* any write, so a
  // malformed call never creates a pipeline_runs row — same rule as the
  // auth failure above. The earlier version created a run row and then
  // marked it failed when external_id was missing, which contradicted
  // DESIGN's error-handling contract.
  if (!body || typeof body.org_id !== "string" || !UUID_RE.test(body.org_id)) {
    return json({ error: "org_id must be a uuid" }, 400);
  }
  const event = body.event as { external_id?: unknown } | null;
  if (!event || typeof event !== "object") {
    return json({ error: "malformed_body: event required" }, 400);
  }
  if (typeof event.external_id !== "string" || event.external_id.length === 0) {
    return json({ error: "malformed_body: event.external_id required" }, 400);
  }
  const externalId = event.external_id;

  const source = body.source ?? "mock-provider";

  // D-13 (other half): webhook-created runs must be reaped like polling
  // runs, so an invocation killed mid-run cannot leave a row stuck at
  // 'running' forever. The polling path reaps inside
  // try_start_polling_run; the published contract from lane W2-B
  // (migration 20260821110000_scheduler_locks_and_cron.sql) has this path
  // call the same function directly, before opening its run.
  const { data: reaped, error: reapError } = await supabase.rpc("reap_abandoned_runs", {
    p_org_id: body.org_id,
    p_source: source,
  });
  if (reapError) log("reap_failed", { error: reapError.message });
  else if (typeof reaped === "number" && reaped > 0) log("runs_reaped", { count: reaped });

  // kind='webhook', not 'incremental': the polling path resumes from the
  // newest succeeded incremental run's cursor_to, and a cursorless webhook
  // run masquerading as one used to reset it to offset 0.
  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      org_id: body.org_id,
      source,
      kind: "webhook",
      status: "running",
      rows_read: 1,
      correlation_id: correlationId,
    })
    .select("id")
    .single();

  if (runError || !run) {
    log("run_start_failed", { error: runError?.message });
    return json({ error: "run_create_failed", details: runError?.message }, 500);
  }

  const runId = run.id as string;

  try {
    const result = validateInvoice(body.event);
    const payloadHash = await hashPayload(body.event);

    // Same atomic ingest the polling path uses — one transaction covering
    // the raw_events insert and its invoices/quarantine counterpart, so an
    // at-least-once redelivery can't be swallowed as a "duplicate" while
    // the record has no downstream row. This is what makes US-05's
    // "reuses the same idempotency guarantee" true in substance.
    const { data: ingested, error: ingestError } = await supabase
      .rpc("ingest_raw_event", {
        p_org_id: body.org_id,
        p_source: source,
        p_external_id: externalId,
        p_event_version: EVENT_VERSION,
        p_payload: body.event,
        p_payload_hash: payloadHash,
        p_run_id: runId,
        p_pipeline_version: PIPELINE_VERSION,
        p_customer: result.ok ? result.invoice.customer : null,
        p_amount_cents: result.ok ? result.invoice.amount_cents : null,
        p_currency: result.ok ? result.invoice.currency : null,
        p_status: result.ok ? result.invoice.status : null,
        p_issued_at: result.ok ? result.invoice.issued_at : null,
        p_quarantine_reason: result.ok ? null : result.reason,
        p_quarantine_details: result.ok ? null : (result.details ?? null),
      })
      .single();

    if (ingestError) {
      await failRun(supabase, runId, ingestError.message);
      log("ingest_failed", { run_id: runId, external_id: externalId, error: ingestError.message });
      return json({ error: "db_error", run_id: runId }, 500);
    }

    const { outcome, raw_event_id: rawEventId } = ingested as IngestOutcome;

    await supabase
      .from("pipeline_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        rows_written: outcome === "written" ? 1 : 0,
        rows_quarantined: outcome === "quarantined" ? 1 : 0,
        rows_deduplicated: outcome === "duplicate" ? 1 : 0,
      })
      .eq("id", runId);

    log("webhook_ingested", { run_id: runId, external_id: externalId, outcome });

    if (outcome === "duplicate") {
      return json({ status: "duplicate", run_id: runId, raw_event_id: rawEventId }, 200);
    }
    if (outcome === "quarantined") {
      return json(
        {
          status: "quarantined",
          run_id: runId,
          raw_event_id: rawEventId,
          quarantine_reason: result.ok ? null : result.reason,
        },
        200,
      );
    }
    return json({ status: "succeeded", run_id: runId, raw_event_id: rawEventId }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRun(supabase, runId, message);
    log("webhook_unexpected_error", { run_id: runId, error: message });
    return json({ error: "unexpected_error", run_id: runId }, 500);
  }
});
