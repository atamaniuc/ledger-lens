import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/platform/supabase/service-client";
import { validateInvoice } from "@/features/ingestion/transform";
import { withRetry, RetryableError } from "@/features/ingestion/backoff";
import { hashPayload } from "@/platform/hash";
import { EVENT_VERSION, PIPELINE_VERSION, type IngestOutcome } from "@/features/ingestion/constants";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  MAX_PAGES_PER_RUN,
  countersBalance,
  nextCursorTo,
  parseCursor,
  parseRetryAfterMs,
  parseRunStart,
} from "@/features/ingestion/cursor";
import type { RawInvoice } from "@/features/provider/data";
import {
  fetchProviderSummary,
  runChecks,
  type RunChecksOutcome,
} from "@/features/quality/run-checks";
import { getTracer } from "@/platform/obs";

// Route-level integration testing (idempotency, circuit breaker) needs
// SUPABASE_SERVICE_ROLE_KEY in .env.local — not available in the
// environment this was built in. The pure decision logic it depends on
// lives in src/features/ingestion/{cursor,backoff,transform}.ts and is unit-tested;
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
  // one so a caller (the pg_cron scheduler of spec 0003, a manual trigger)
  // can tie its own logs to this run's.
  const correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ correlation_id: correlationId, event, ...fields }));

  // Spec 0011 (D-45): one trace per run, keyed by the same correlation_id
  // the log lines carry — a span line and a log line with the same id are
  // the same request. Every child span below inherits runSpan's trace id;
  // nothing in this route ever mints a new root. Exported as structured
  // JSON to stdout by default (see src/platform/obs/exporters.ts).
  const tracer = getTracer();
  const runSpan = tracer.startSpan("ingest.run", {
    traceId: correlationId,
    kind: "server",
    attributes: { org_id: orgId, source },
  });

  const supabase = createServiceClient();
  const baseUrl = process.env.MOCK_PROVIDER_BASE_URL || req.nextUrl.origin;

  // Spec 0003 (D-12/D-13): the start is now one atomic RPC. The function
  // reaps abandoned runs (the single reap path, shared with the webhook),
  // takes the org's transaction-scoped advisory lock, re-reads the resume
  // cursor under it and inserts the running row — so two overlapping starts
  // cannot both advance the same cursor, and the partial unique index on
  // pipeline_runs(org_id) where status='running' is the race-proof backstop.
  // A refused start is a clean 409 with a reason, never a crashed 500.
  //
  // US-01: resume from the last succeeded *polling* run's cursor_to, read
  // inside the RPC. kind='incremental' and the not-null cursor filter both
  // matter there: the webhook path writes succeeded rows for the same
  // (org_id, source) with no cursor at all, so without those filters a
  // single webhook delivery would become the newest succeeded run and reset
  // this path to offset 0.
  const startSpan = tracer.startSpan("ingest.start", {
    parent: runSpan,
    kind: "client",
    attributes: { org_id: orgId, source },
  });
  const { data: startRow, error: startError } = await supabase
    .rpc("try_start_polling_run", {
      p_org_id: orgId,
      p_source: source,
      p_correlation_id: correlationId,
    })
    .single();

  if (startError || !startRow) {
    tracer.endSpan(startSpan, "error", new Error(startError?.message ?? "no start row returned"));
    log("run_start_failed", { error: startError?.message ?? "no start row returned" });
    runSpan.setAttribute("outcome", "start_failed");
    tracer.endSpan(runSpan, "error", new Error(startError?.message ?? "no start row returned"));
    await tracer.flush();
    return NextResponse.json({ error: "failed_to_start_run" }, { status: 500 });
  }
  tracer.endSpan(startSpan, "ok");

  const start = parseRunStart(startRow);
  if (!start.started) {
    log("run_refused", { org_id: orgId, source, reason: start.refused_reason });
    runSpan.setAttribute("outcome", "refused");
    runSpan.setAttribute("refused_reason", start.refused_reason ?? "unknown");
    tracer.endSpan(runSpan, "ok");
    await tracer.flush();
    return NextResponse.json(
      { error: "run_in_progress", reason: start.refused_reason },
      { status: 409 },
    );
  }
  if (start.reaped > 0) log("runs_reaped", { count: start.reaped });

  const runId: string = start.run_id as string;
  runSpan.setAttribute("run_id", runId);
  const resumeCursor: string | null = start.cursor_from;
  log("run_started", { run_id: runId, org_id: orgId, source, cursor_from: resumeCursor });

  let token = crypto.randomUUID();

  async function fetchPage(cursor: string | null): Promise<UpstreamPage> {
    return withRetry(
      async (attempt) => {
        // One span per attempt: the retry storm itself is what ops need to
        // see, not just the final failure the caller observes.
        const span = tracer.startSpan("ingest.page_fetch", {
          parent: runSpan,
          kind: "client",
          attributes: { cursor: cursor ?? null, attempt },
        });
        try {
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

          const page = (await res.json()) as UpstreamPage;
          tracer.endSpan(span, "ok");
          return page;
        } catch (err) {
          tracer.endSpan(span, "error", err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      },
      {
        // Spec 0011: retries were previously invisible until the retry
        // budget ran out — the route only saw the final error. Each
        // attempt is now a correlation_id-tagged log line too.
        onRetry: (info) =>
          log("page_fetch_retry", {
            cursor,
            attempt: info.attempt,
            next_attempt: info.nextAttempt,
            delay_ms: Math.round(info.delayMs),
            error: info.error instanceof Error ? info.error.message : String(info.error),
          }),
      },
    );
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

    // The transform + atomic write of one page: the "ingest → transform"
    // stage of the trace chain (spec 0011). Ended as an error only when
    // this page's records are what aborted the run.
    const pageSpan = tracer.startSpan("ingest.page_process", {
      parent: runSpan,
      attributes: { cursor: cursor ?? null, page: pagesProcessed, records: page.data.length },
    });
    const abortBeforePage: string | null = abortReason;

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

    if (abortReason !== abortBeforePage) {
      tracer.endSpan(pageSpan, "error", new Error(abortReason ?? "page aborted"));
    } else {
      tracer.endSpan(pageSpan, "ok");
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

  // Stage 3, US-05: every run gets a data-quality verdict, without a
  // scheduler to deploy. Deliberately after closeRun — the checks read
  // pipeline_runs.rows_written, so they need the closed-out numbers, not the
  // zeros the row still carried while the run was open.
  //
  // A failure here never fails the ingestion run. The data is already
  // written and the counters are already persisted; losing the verdict is a
  // gap in observability, not a corrupted ingest, and reporting the run as
  // failed would be a lie that a retry would then act on.
  let dataQuality: RunChecksOutcome | null = null;
  if (status === "succeeded") {
    // The "quality" stage of the trace chain (spec 0011). The checks
    // themselves are one RPC; the provider-summary fetch above it is the
    // one HTTP hop, and both share this span's trace id.
    const qualitySpan = tracer.startSpan("quality.checks", {
      parent: runSpan,
      attributes: { run_id: runId },
    });
    try {
      const summary = await fetchProviderSummary(baseUrl);
      dataQuality = await runChecks(supabase, { orgId, runId, summary });
      tracer.endSpan(qualitySpan, "ok");
      log("data_quality_checked", {
        run_id: runId,
        overall: dataQuality.overall,
        complete: dataQuality.complete,
      });
    } catch (err) {
      tracer.endSpan(qualitySpan, "error", err instanceof Error ? err : new Error(String(err)));
      log("data_quality_failed", {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const counters = { rowsRead, rowsWritten, rowsQuarantined, rowsDeduplicated };
  const balanced = countersBalance(counters);
  if (!balanced) {
    // Every record read must have landed in exactly one bucket. An
    // imbalance means a silent drop, which is the PRD's counter-metric
    // failing — worth a loud log line even though the run itself completed.
    log("counter_imbalance", { run_id: runId, ...counters });
  }

  log("run_finished", { run_id: runId, status, cursor_to: cursorTo, pagesProcessed, ...counters });

  runSpan.setAttribute("outcome", status);
  runSpan.setAttribute("pages_processed", pagesProcessed);
  runSpan.setAttribute("rows_read", rowsRead);
  runSpan.setAttribute("rows_written", rowsWritten);
  runSpan.setAttribute("rows_quarantined", rowsQuarantined);
  runSpan.setAttribute("rows_deduplicated", rowsDeduplicated);
  tracer.endSpan(
    runSpan,
    status === "succeeded" ? "ok" : "error",
    status === "failed" ? new Error(abortReason ?? "run failed") : undefined,
  );

  // Hand whatever the exporter has buffered to the collector (a no-op for
  // the default stdout exporter); never fails the run it is observing.
  await tracer.flush();

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
    // null when the run failed, or when the checks themselves could not run
    // — distinguishable from a passing verdict, which is the point.
    data_quality: dataQuality,
  });
}