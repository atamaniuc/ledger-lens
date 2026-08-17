// Deno Edge Function — provider push path for Stage 2 ingestion.
// Reuses lib/ingestion/transform.ts and lib/ingestion/hash.ts verbatim
// (relative-path import, Deno resolves local .ts natively — ADR 0002)
// so idempotency and validation are proven once, not reimplemented for
// the push path. See .claude/DESIGN.md's "Ingestion & Transform"
// section and .claude/PRD.md US-05.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { validateInvoice } from "../../../lib/ingestion/transform.ts";
import { hashPayload } from "../../../lib/ingestion/hash.ts";
import {
  EVENT_VERSION,
  PIPELINE_VERSION,
  type IngestOutcome,
} from "../../../lib/ingestion/constants.ts";

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
  // row (DESIGN.md: "nothing happened, nothing to record").
  const providedSecret = req.headers.get("x-webhook-secret");
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    log("webhook_unauthorized");
    return json({ error: "unauthorized" }, 401);
  }

  let body: WebhookBody;
  try {
    body = await req.json();
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
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
