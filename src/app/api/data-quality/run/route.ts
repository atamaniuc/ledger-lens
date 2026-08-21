import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/platform/supabase/service-client";
import { fetchProviderSummary, runChecks } from "@/features/quality/run-checks";
import { getTracer } from "@/platform/obs";

// Stage 3 (Data Quality & Reconciliation). See ADR 0005 and the
// "Data Quality & Reconciliation" entry in .claude/PRD.md.
//
// The four checks themselves run inside one Postgres function. This route
// exists because one of them — reconciliation — needs the provider's own
// independent total, and Postgres makes no outbound HTTP request here. The
// route fetches that number and hands it in.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  // Same shared-secret gate as the ingestion trigger: this route writes with
  // the service-role client and takes org_id from its body, so a filter the
  // caller controls is not tenant isolation.
  const expectedSecret = process.env.INGESTION_TRIGGER_SECRET;
  if (!expectedSecret || req.headers.get("x-ingestion-secret") !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgId: unknown = body?.org_id;
  const runId: unknown = body?.run_id ?? null;

  if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
    return NextResponse.json({ error: "org_id must be a uuid" }, { status: 400 });
  }
  if (runId !== null && (typeof runId !== "string" || !UUID_RE.test(runId))) {
    return NextResponse.json({ error: "run_id must be a uuid or omitted" }, { status: 400 });
  }

  const correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

  // Spec 0011 (D-45): the "quality" stage of the trace chain, keyed by the
  // same correlation_id the log lines carry. Children inherit this span's
  // trace id; nothing here mints a new root.
  const tracer = getTracer();
  const runSpan = tracer.startSpan("quality.run", {
    traceId: correlationId,
    kind: "server",
    attributes: { org_id: orgId, run_id: runId ?? null },
  });

  const baseUrl = process.env.MOCK_PROVIDER_BASE_URL || req.nextUrl.origin;

  // Fetched before anything is written. Three checks would succeed without
  // it, but a result set missing its reconciliation row reads as
  // "reconciliation was not configured" rather than "could not run" — and
  // the dashboard has no way to tell those apart.
  let summary;
  const summarySpan = tracer.startSpan("quality.provider_summary", {
    parent: runSpan,
    kind: "client",
    attributes: { org_id: orgId },
  });
  try {
    summary = await fetchProviderSummary(baseUrl);
    tracer.endSpan(summarySpan, "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.endSpan(summarySpan, "error", new Error(message));
    log("provider_summary_failed", { error: message });
    runSpan.setAttribute("outcome", "provider_summary_unavailable");
    tracer.endSpan(runSpan, "error", new Error(message));
    await tracer.flush();
    return NextResponse.json(
      { error: "provider_summary_unavailable", detail: message },
      { status: 502 },
    );
  }

  const supabase = createServiceClient();
  let outcome;
  const checksSpan = tracer.startSpan("quality.checks", {
    parent: runSpan,
    attributes: { org_id: orgId, run_id: runId ?? null },
  });
  try {
    outcome = await runChecks(supabase, { orgId, runId, summary });
    tracer.endSpan(checksSpan, "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.endSpan(checksSpan, "error", new Error(message));
    log("checks_failed", { org_id: orgId, run_id: runId, error: message });
    runSpan.setAttribute("outcome", "checks_failed");
    tracer.endSpan(runSpan, "error", new Error(message));
    await tracer.flush();
    return NextResponse.json({ error: "checks_failed", detail: message }, { status: 500 });
  }

  if (!outcome.complete) {
    log("incomplete_check_set", { org_id: orgId, run_id: runId, got: outcome.results.length });
  }
  log("checks_completed", {
    org_id: orgId,
    run_id: runId,
    overall: outcome.overall,
    statuses: Object.fromEntries(outcome.results.map((r) => [r.check_name, r.status])),
  });

  runSpan.setAttribute("outcome", outcome.overall);
  tracer.endSpan(runSpan, "ok");

  // Hand whatever the exporter has buffered to the collector (a no-op for
  // the default stdout exporter).
  await tracer.flush();

  return NextResponse.json({
    org_id: orgId,
    run_id: runId,
    correlation_id: correlationId,
    ...outcome,
  });
}
