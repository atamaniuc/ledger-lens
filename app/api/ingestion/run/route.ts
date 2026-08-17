import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service-client";
import { validateInvoice } from "@/lib/ingestion/transform";
import { withRetry, RetryableError } from "@/lib/ingestion/backoff";
import { hashPayload } from "@/lib/ingestion/hash";
import { EVENT_VERSION, PIPELINE_VERSION, type IngestOutcome } from "@/lib/ingestion/constants";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  MAX_PAGES_PER_RUN,
  countersBalance,
  nextCursorTo,
  parseCursor,
  parseRetryAfterMs,
} from "@/lib/ingestion/cursor";
import type { RawInvoice } from "@/lib/mock-provider/data";

// Route-level integration testing (idempotency, circuit breaker) needs
// SUPABASE_SERVICE_ROLE_KEY in .env.local — not available in the
// environment this was built in. The pure decision logic it depends on
// lives in lib/ingestion/{cursor,backoff,transform}.ts and is unit-tested;
// the atomic-write and idempotency guarantees are enforced (and were
// verified) in Postgres itself via the ingest_raw_event function.

// ADR 0003: bounded per-invocation polling, no job queue. The wall-clock
// budget exists because page failures don't consume the page budget —
// worst case is MAX_PAGES_PER_RUN x CONSECUTIVE_FAILURE_LIMIT x retry
// attempts upstream requests, which can outlive a serverless invocation
// and leave the run row stuck at 'running'.
const RUN_BUDGET_MS = 45_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UpstreamPage {
  data: RawInvoice[];
  next_cursor: string | null;
}

export async function POST(req: NextRequest) {
  // The service-role client below bypasses RLS by design, and org_id comes
  // from the request body — so without this check any caller who guesses an
  // orgs.id could write into that tenant. CLAUDE.md's "no cross-org_id
  // query without explicit filter" is not satisfied by a filter the caller
  // controls. Matches the webhook path, which authenticates first.
  const expectedSecret = process.env.INGESTION_TRIGGER_SECRET;
  if (!expectedSecret || req.headers.get("x-ingestion-secret") !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgId: unknown = body?.org_id;
  const source: string = body?.source ?? "mock-provider";

  if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
    // Validated before use: a non-UUID reached Postgres as a cast error and
    // surfaced as a bare 500.
    return NextResponse.json({ error: "org_id must be a uuid" }, { status: 400 });
  }

  // CLAUDE.md: every log line carries a correlation_id. Accepts an inbound
  // one so a caller (Stage 4's cron, a manual trigger) can tie its own logs
  // to this run's.
  const correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

  const supabase = createServiceClient();
  const baseUrl = process.env.MOCK_PROVIDER_BASE_URL || req.nextUrl.origin;

  // US-01: resume from the last succeeded *polling* run's cursor_to.
  //
  // `kind = 'incremental'` and the not-null cursor filter both matter: the
  // webhook path writes succeeded rows for the same (org_id, source) with
  // no cursor at all, so without these a single webhook delivery would
  // become the newest succeeded run and reset this path to offset 0.
  const { data: lastRun } = await supabase
    .from("pipeline_runs")
    .select("cursor_to")
    .eq("org_id", orgId)
    .eq("source", source)
    .eq("kind", "incremental")
    .eq("status", "succeeded")
    .not("cursor_to", "is", null)
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  const resumeCursor: string | null = lastRun?.cursor_to ?? null;

  // An invocation killed by a serverless execution-time limit never runs
  // its own close-out, leaving a row stuck at 'running' that nothing would
  // otherwise notice. Reaping here bounds that by run frequency instead of
  // adding a scheduler (ADR 0003: no job queue).
  const { data: reaped, error: reapError } = await supabase.rpc("reap_abandoned_runs", {
    p_org_id: orgId,
    p_source: source,
  });
  if (reapError) log("reap_failed", { error: reapError.message });
  else if (typeof reaped === "number" && reaped > 0) log("runs_reaped", { count: reaped });

  const { data: runRow, error: runInsertError } = await supabase
    .from("pipeline_runs")
    .insert({
      org_id: orgId,
      source,
      kind: "incremental",
      status: "running",
      cursor_from: resumeCursor,
      correlation_id: correlationId,
    })
    .select("id")
    .single();

  if (runInsertError || !runRow) {
    log("run_start_failed", { error: runInsertError?.message });
    return NextResponse.json({ error: "failed_to_start_run" }, { status: 500 });
  }
  const runId: string = runRow.id;
  log("run_started", { run_id: runId, org_id: orgId, source, cursor_from: resumeCursor });

  let token = crypto.randomUUID();

  async function fetchPage(cursor: string | null): Promise<UpstreamPage> {
    return withRetry(async () => {
      const url = new URL("/api/mock-provider/invoices", baseUrl);
      if (cursor) url.searchParams.set("cursor", cursor);

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        throw new RetryableError(`network_error: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        throw new RetryableError("rate_limited", parseRetryAfterMs(res.headers.get("Retry-After")));
      }
      if (res.status === 401) {
        // The mock provider counts requests per token string, not token
        // identity — rotating simulates a token refresh and unblocks the
        // next attempt. The expiredToken chaos flag is therefore exercised
        // (we do hit the 401) but not fatal, which is the intended
        // behavior for a client that can refresh.
        token = crypto.randomUUID();
        throw new RetryableError("token_expired");
      }
      if (!res.ok) {
        throw new RetryableError(`upstream_error_${res.status}`);
      }

      return (await res.json()) as UpstreamPage;
    });
  }

  const deadline = Date.now() + RUN_BUDGET_MS;
  let offset = parseCursor(resumeCursor);
  let cursor: string | null = resumeCursor;
  let cursorTo: string | null = resumeCursor;
  let pagesProcessed = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  let rowsQuarantined = 0;
  let rowsDeduplicated = 0;
  let consecutivePageFailures = 0;
  let consecutiveRecordFailures = 0;
  let abortReason: string | null = null;

  const closeRun = async (status: "succeeded" | "failed", error: string | null) => {
    const { error: updateError } = await supabase
      .from("pipeline_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        cursor_to: cursorTo,
        rows_read: rowsRead,
        rows_written: rowsWritten,
        rows_quarantined: rowsQuarantined,
        rows_deduplicated: rowsDeduplicated,
        error,
      })
      .eq("id", runId);

    // The one write whose entire job is bookkeeping accuracy — a swallowed
    // failure here means the row stays 'running' while the response claims
    // otherwise.
    if (updateError) log("run_close_failed", { run_id: runId, error: updateError.message });
  };

  while (pagesProcessed < MAX_PAGES_PER_RUN) {
    if (Date.now() > deadline) {
      abortReason = `run_budget_exceeded after ${pagesProcessed} pages`;
      break;
    }

    let page: UpstreamPage;
    try {
      page = await fetchPage(cursor);
    } catch (err) {
      consecutivePageFailures++;
      const message = err instanceof Error ? err.message : String(err);
      log("page_fetch_failed", { cursor, consecutive: consecutivePageFailures, error: message });
      if (consecutivePageFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        abortReason = `circuit_breaker_tripped: ${CONSECUTIVE_FAILURE_LIMIT} consecutive page fetch failures: ${message}`;
        break;
      }
      // Same cursor is retried — a failed page is never skipped, and
      // cursor_to is never advanced past it.
      continue;
    }
    consecutivePageFailures = 0;

    for (const record of page.data) {
      rowsRead++;
      const result = validateInvoice(record);

      try {
        const payloadHash = await hashPayload(record);
        // One atomic call: the raw_events insert and its invoices/quarantine
        // counterpart commit together, so an interrupted write can't leave a
        // raw event with no downstream row (which the idempotency check
        // would then swallow forever as a "duplicate").
        const { data: ingested, error: ingestError } = await supabase
          .rpc("ingest_raw_event", {
            p_org_id: orgId,
            p_source: source,
            p_external_id: record.external_id,
            p_event_version: EVENT_VERSION,
            p_payload: record,
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

        if (ingestError) throw ingestError;
        consecutiveRecordFailures = 0;

        switch ((ingested as IngestOutcome | null)?.outcome) {
          case "written":
            rowsWritten++;
            break;
          case "quarantined":
            rowsQuarantined++;
            break;
          default:
            // 'duplicate' — already ingested *and* already has a downstream
            // row. US-03's idempotency guarantee.
            rowsDeduplicated++;
        }
      } catch (err) {
        // US-04: a record that fails to write is quarantined, not dropped,
        // and does not kill the page. Zod-invalid records are already
        // handled above; this covers what the DB rejects but Zod allowed
        // (an impossible date like 2026-13-45, an over-length customer, a
        // missing external_id) plus transient write failures.
        const message = err instanceof Error ? err.message : String(err);
        consecutiveRecordFailures++;
        log("record_write_failed", {
          external_id: record.external_id,
          consecutive: consecutiveRecordFailures,
          error: message,
        });

        const { error: quarantineError } = await supabase.from("quarantine").insert({
          org_id: orgId,
          // Null on purpose: the atomic ingest rolled back, so there is no
          // raw_events row to point at. The column is nullable for exactly
          // this case.
          raw_event_id: null,
          run_id: runId,
          reason: `db_write_failed: ${message}`,
          details: { external_id: record.external_id },
        });
        if (quarantineError) {
          // Can't even quarantine — the DB itself is the problem, so
          // continuing would just burn the rest of the dataset.
          abortReason = `quarantine_write_failed: ${quarantineError.message}`;
          break;
        }
        rowsQuarantined++;

        if (consecutiveRecordFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          abortReason = `record_failure_limit: ${CONSECUTIVE_FAILURE_LIMIT} consecutive record write failures: ${message}`;
          break;
        }
      }
    }

    if (abortReason) break;

    pagesProcessed++;
    // Only advanced once every record on the page is accounted for.
    cursorTo = nextCursorTo(offset, page.data.length, page.next_cursor);
    offset += page.data.length;
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }

  const status: "succeeded" | "failed" = abortReason ? "failed" : "succeeded";
  await closeRun(status, abortReason);

  const counters = { rowsRead, rowsWritten, rowsQuarantined, rowsDeduplicated };
  const balanced = countersBalance(counters);
  if (!balanced) {
    // Every record read must have landed in exactly one bucket. An
    // imbalance means a silent drop, which is the PRD's counter-metric
    // failing — worth a loud log line even though the run itself completed.
    log("counter_imbalance", { run_id: runId, ...counters });
  }

  log("run_finished", { run_id: runId, status, cursor_to: cursorTo, pagesProcessed, ...counters });

  return NextResponse.json({
    run_id: runId,
    correlation_id: correlationId,
    status,
    cursor_to: cursorTo,
    rows_read: rowsRead,
    rows_written: rowsWritten,
    rows_quarantined: rowsQuarantined,
    rows_deduplicated: rowsDeduplicated,
    counters_balanced: balanced,
    pages_processed: pagesProcessed,
    error: abortReason,
  });
}
