// Deno Edge Function — the Modal transcription push path (spec 0009, D-42).
// Modal transcribes audio on its serverless GPU and calls back here with a
// timestamped transcript; this function drops it into the SAME pipeline as
// invoices: a raw_events row (source 'transcription', run_id, correlation_id)
// plus a documents row (kind 'transcript') that the existing indexer chunks,
// embeds and searches, or a quarantine row with a reason when the transcript
// is malformed. Not a side channel — the transform gate below is the same
// decision shape as provider-webhook's validateInvoice, and the atomic
// write is the same one-transaction contract (ADR 0004).
//
// Auth (D-19): identical to provider-webhook — HMAC-SHA256 over
// `v1:<timestamp>:<nonce>:<rawBody>`, constant-time, with a freshness window
// and a single-use nonce held in Postgres. An unsigned or replayed callback
// is refused before anything is read or written.
//
// Idempotency: keyed on content. raw_events' unique
// (org_id, source, external_id, event_version) uses external_id = the audio
// file's sha256 (audio_hash), so the same audio delivered twice — Modal
// retrying, a user re-uploading — produces one transcript and one set of
// chunks.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
// The digest and the payload key are shared, not copied: src/platform/hash.ts
// imports nothing, so Deno resolves it directly the same way this function
// imports transform code from src/ (decision 0002, and D-49 for why nothing
// reachable from here may use a path alias).
import { hashPayload, sha256Hex } from "../../../src/platform/hash.ts";
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
import { validateTranscript } from "./transform.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SOURCE = "transcription";



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
  // row (same rule as provider-webhook).
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

  // The replay half of D-19: the nonce is single-use. Only reached after the
  // signature verified; a reused nonce is a replayed signed request, fail
  // closed.
  const { data: consumed, error: nonceError } = await supabase.rpc(
    "consume_request_nonce",
    {
      p_nonce: signatureCheck.nonce,
      p_expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    },
  );
  if (nonceError || consumed !== true) {
    log("webhook_nonce_rejected", { reason: nonceError?.message ?? "reused_nonce" });
    return json({ error: "unauthorized" }, 401);
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  // Everything the body must satisfy is checked before any write, so a
  // malformed call never creates a pipeline_runs row.
  if (!body || typeof body.org_id !== "string" || !UUID_RE.test(body.org_id)) {
    return json({ error: "org_id must be a uuid" }, 400);
  }
  const event = body.event as Record<string, unknown> | null;
  if (!event || typeof event !== "object") {
    return json({ error: "malformed_body: event required" }, 400);
  }
  if (typeof event.audio_hash !== "string" || !/^[0-9a-f]{64}$/.test(event.audio_hash)) {
    return json({ error: "malformed_body: event.audio_hash (64-char sha256 hex) required" }, 400);
  }

  const source = body.source ?? DEFAULT_SOURCE;
  const externalId = event.audio_hash;

  // Same reaping contract as provider-webhook (D-13): a webhook run killed
  // mid-flight cannot leave a 'running' row forever.
  const { data: reaped, error: reapError } = await supabase.rpc("reap_abandoned_runs", {
    p_org_id: body.org_id,
    p_source: source,
  });
  if (reapError) log("reap_failed", { error: reapError.message });
  else if (typeof reaped === "number" && reaped > 0) log("runs_reaped", { count: reaped });

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
    // The transform is the gate: malformed content and impossible dates
    // quarantine with a reason, exactly like every other source.
    const result = await validateTranscript(event);
    const payload = result.ok ? result.event : event;
    const payloadHash = await hashPayload(payload);

    const { data: ingested, error: ingestError } = await supabase
      .rpc("ingest_transcript", {
        p_org_id: body.org_id,
        p_source: source,
        p_external_id: externalId,
        p_event_version: EVENT_VERSION,
        p_payload: payload,
        p_payload_hash: payloadHash,
        p_run_id: runId,
        p_pipeline_version: PIPELINE_VERSION,
        p_title: result.ok ? result.title : null,
        p_kind: "transcript",
        p_body: result.ok ? result.body : null,
        p_content_hash: result.ok ? result.content_hash : null,
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