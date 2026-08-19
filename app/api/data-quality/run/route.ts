import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service-client";
import { fetchProviderSummary, runChecks } from "@/lib/data-quality/run-checks";

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

  const baseUrl = process.env.MOCK_PROVIDER_BASE_URL || req.nextUrl.origin;

  // Fetched before anything is written. Three checks would succeed without
  // it, but a result set missing its reconciliation row reads as
  // "reconciliation was not configured" rather than "could not run" — and
  // the dashboard has no way to tell those apart.
  let summary;
  try {
    summary = await fetchProviderSummary(baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("provider_summary_failed", { error: message });
    return NextResponse.json(
      { error: "provider_summary_unavailable", detail: message },
      { status: 502 },
    );
  }

  const supabase = createServiceClient();
  let outcome;
  try {
    outcome = await runChecks(supabase, { orgId, runId, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("checks_failed", { org_id: orgId, run_id: runId, error: message });
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

  return NextResponse.json({
    org_id: orgId,
    run_id: runId,
    correlation_id: correlationId,
    ...outcome,
  });
}
