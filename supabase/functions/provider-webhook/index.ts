// Deno Edge Function — provider push path for Stage 2 ingestion.
// Reuses lib/ingestion/transform.ts and lib/ingestion/hash.ts verbatim
// (relative-path import, Deno resolves local .ts natively — ADR 0002)
// so idempotency and validation are proven once, not reimplemented for
// the push path. See .claude/DESIGN.md's "Ingestion & Transform"
// section and .claude/PRD.md US-05.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { validateInvoice } from "../../../lib/ingestion/transform.ts";
import { hashPayload } from "../../../lib/ingestion/hash.ts";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SHARED_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
  await supabase
    .from("pipeline_runs")
    .update({ status: "failed", finished_at: new Date().toISOString(), error })
    .eq("id", runId);
}

Deno.serve(async (req: Request) => {
  // Auth first — a rejected call writes nothing, not even a pipeline_runs
  // row (DESIGN.md: "nothing happened, nothing to record").
  const providedSecret = req.headers.get("x-webhook-secret");
  if (!WEBHOOK_SECRET || providedSecret !== WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: WebhookBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: "malformed_json" }, 400);
  }

  if (!body || typeof body.org_id !== "string" || body.org_id.length === 0 || !body.event) {
    return json({ error: "malformed_body" }, 400);
  }

  const source = body.source ?? "mock-provider";
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: run, error: runError } = await supabase
    .from("pipeline_runs")
    .insert({
      org_id: body.org_id,
      source,
      kind: "incremental",
      status: "running",
      rows_read: 1,
    })
    .select("id")
    .single();

  if (runError || !run) {
    return json({ error: "run_create_failed", details: runError?.message }, 500);
  }

  const runId = run.id as string;

  try {
    const externalId = (body.event as { external_id?: unknown }).external_id;
    if (typeof externalId !== "string" || externalId.length === 0) {
      await failRun(supabase, runId, "missing external_id");
      return json({ error: "malformed_body", run_id: runId }, 400);
    }

    const payloadHash = await hashPayload(body.event);

    // Same idempotency guarantee as the polling path: INSERT ... ON
    // CONFLICT DO NOTHING RETURNING id. An empty return = already
    // ingested = idempotent no-op, not an error.
    const { data: rawRows, error: rawError } = await supabase
      .from("raw_events")
      .upsert(
        {
          org_id: body.org_id,
          source,
          external_id: externalId,
          event_version: "1",
          payload: body.event,
          payload_hash: payloadHash,
          run_id: runId,
        },
        { onConflict: "source,external_id,event_version", ignoreDuplicates: true },
      )
      .select("id");

    if (rawError) {
      await failRun(supabase, runId, rawError.message);
      return json({ error: "db_error", run_id: runId }, 500);
    }

    if (!rawRows || rawRows.length === 0) {
      await supabase
        .from("pipeline_runs")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          rows_written: 0,
          rows_quarantined: 0,
        })
        .eq("id", runId);
      return json({ status: "duplicate", run_id: runId }, 200);
    }

    const rawEventId = rawRows[0].id as number;
    const result = validateInvoice(body.event);

    if (result.ok) {
      const { data: invoice, error: invoiceError } = await supabase
        .from("invoices")
        .insert({
          org_id: body.org_id,
          external_id: result.invoice.external_id,
          customer: result.invoice.customer,
          amount_cents: result.invoice.amount_cents,
          currency: result.invoice.currency,
          status: result.invoice.status,
          issued_at: result.invoice.issued_at,
          raw_event_id: rawEventId,
          run_id: runId,
          pipeline_version: "1",
        })
        .select("id")
        .single();

      if (invoiceError || !invoice) {
        await failRun(supabase, runId, invoiceError?.message ?? "invoice_insert_failed");
        return json({ error: "db_error", run_id: runId }, 500);
      }

      await supabase
        .from("pipeline_runs")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          rows_written: 1,
          rows_quarantined: 0,
        })
        .eq("id", runId);

      return json({ status: "succeeded", raw_event_id: rawEventId, invoice_id: invoice.id }, 200);
    }

    const { error: quarantineError } = await supabase.from("quarantine").insert({
      org_id: body.org_id,
      raw_event_id: rawEventId,
      run_id: runId,
      reason: result.reason,
      details: result.details ?? null,
    });

    if (quarantineError) {
      await failRun(supabase, runId, quarantineError.message);
      return json({ error: "db_error", run_id: runId }, 500);
    }

    await supabase
      .from("pipeline_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        rows_written: 0,
        rows_quarantined: 1,
      })
      .eq("id", runId);

    return json(
      { status: "quarantined", raw_event_id: rawEventId, quarantine_reason: result.reason },
      200,
    );
  } catch (err) {
    await failRun(supabase, runId, err instanceof Error ? err.message : String(err));
    return json({ error: "unexpected_error", run_id: runId }, 500);
  }
});
