import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service-client";
import { validateInvoice } from "@/lib/ingestion/transform";
import { withRetry, RetryableError } from "@/lib/ingestion/backoff";
import { hashPayload } from "@/lib/ingestion/hash";
import type { RawInvoice } from "@/lib/mock-provider/data";

// Route-level integration testing (idempotency, circuit breaker) needs
// SUPABASE_SERVICE_ROLE_KEY in .env.local — not available in this
// environment, unit tests cover the pure logic only.

// ADR 0003: bounded per-invocation polling, no job queue.
const MAX_PAGES_PER_RUN = 20;
const CONSECUTIVE_FAILURE_LIMIT = 5;
const EVENT_VERSION = "1";
const PIPELINE_VERSION = "1";

interface UpstreamPage {
  data: RawInvoice[];
  next_cursor: string | null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const orgId: string | undefined = body?.org_id;
  const source: string = body?.source ?? "mock-provider";

  if (!orgId) {
    return NextResponse.json({ error: "org_id is required" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const baseUrl = process.env.MOCK_PROVIDER_BASE_URL || req.nextUrl.origin;

  // US-01: resume from the last succeeded run's cursor_to, or start fresh.
  const { data: lastRun } = await supabase
    .from("pipeline_runs")
    .select("cursor_to")
    .eq("org_id", orgId)
    .eq("source", source)
    .eq("status", "succeeded")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const resumeCursor: string | undefined = lastRun?.cursor_to ?? undefined;

  const { data: runRow, error: runInsertError } = await supabase
    .from("pipeline_runs")
    .insert({
      org_id: orgId,
      source,
      kind: "incremental",
      status: "running",
      cursor_from: resumeCursor ?? null,
    })
    .select("id")
    .single();

  if (runInsertError || !runRow) {
    return NextResponse.json({ error: "failed_to_start_run" }, { status: 500 });
  }
  const runId: string = runRow.id;

  let token = crypto.randomUUID();

  async function fetchPage(cursor: string | undefined): Promise<UpstreamPage> {
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
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        throw new RetryableError("rate_limited", retryAfterMs);
      }
      if (res.status === 401) {
        // The mock provider counts requests per token string, not token
        // identity — rotating unblocks the next attempt.
        token = crypto.randomUUID();
        throw new RetryableError("token_expired");
      }
      if (!res.ok) {
        throw new RetryableError(`upstream_error_${res.status}`);
      }

      return (await res.json()) as UpstreamPage;
    });
  }

  let cursor = resumeCursor;
  let cursorTo: string | null = resumeCursor ?? null;
  let pagesProcessed = 0;
  let rowsRead = 0;
  let rowsWritten = 0;
  let rowsQuarantined = 0;
  let consecutiveFailures = 0;
  let breakerError: string | null = null;

  try {
    while (pagesProcessed < MAX_PAGES_PER_RUN) {
      let page: UpstreamPage;
      try {
        page = await fetchPage(cursor);
      } catch (err) {
        consecutiveFailures++;
        breakerError = err instanceof Error ? err.message : String(err);
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
          break;
        }
        continue;
      }

      consecutiveFailures = 0;
      breakerError = null;

      for (const record of page.data) {
        rowsRead++;

        const payloadHash = await hashPayload(record);
        const { data: insertedRows, error: insertError } = await supabase
          .from("raw_events")
          .upsert(
            {
              org_id: orgId,
              source,
              external_id: record.external_id,
              event_version: EVENT_VERSION,
              payload: record,
              payload_hash: payloadHash,
              run_id: runId,
            },
            { onConflict: "source,external_id,event_version", ignoreDuplicates: true },
          )
          .select("id");

        if (insertError) throw insertError;
        if (!insertedRows || insertedRows.length === 0) {
          // Already ingested — idempotency guarantee (US-03). Skip transform.
          continue;
        }

        const rawEventId = insertedRows[0].id;
        const result = validateInvoice(record);

        if (result.ok) {
          const { error: invoiceError } = await supabase.from("invoices").insert({
            org_id: orgId,
            external_id: result.invoice.external_id,
            customer: result.invoice.customer,
            amount_cents: result.invoice.amount_cents,
            currency: result.invoice.currency,
            status: result.invoice.status,
            issued_at: result.invoice.issued_at,
            raw_event_id: rawEventId,
            run_id: runId,
            pipeline_version: PIPELINE_VERSION,
          });
          if (invoiceError) throw invoiceError;
          rowsWritten++;
        } else {
          const { error: quarantineError } = await supabase.from("quarantine").insert({
            org_id: orgId,
            raw_event_id: rawEventId,
            run_id: runId,
            reason: result.reason,
            details: result.details ?? null,
          });
          if (quarantineError) throw quarantineError;
          rowsQuarantined++;
        }
      }

      pagesProcessed++;
      cursorTo = page.next_cursor;
      if (page.next_cursor === null) {
        cursor = undefined;
        break;
      }
      cursor = page.next_cursor;
    }
  } catch (err) {
    // Unexpected DB/server error mid-run — still close out the run row
    // rather than leaving it stuck at 'running'.
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("pipeline_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        cursor_to: cursorTo,
        rows_read: rowsRead,
        rows_written: rowsWritten,
        rows_quarantined: rowsQuarantined,
        error: `unexpected_error: ${message}`,
      })
      .eq("id", runId);
    return NextResponse.json({ error: "unexpected_error", run_id: runId }, { status: 500 });
  }

  const breakerTripped = consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT;
  const status: "succeeded" | "failed" = breakerTripped ? "failed" : "succeeded";

  await supabase
    .from("pipeline_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      cursor_to: cursorTo,
      rows_read: rowsRead,
      rows_written: rowsWritten,
      rows_quarantined: rowsQuarantined,
      error: breakerTripped
        ? `circuit_breaker_tripped: ${CONSECUTIVE_FAILURE_LIMIT} consecutive page fetch failures: ${breakerError}`
        : null,
    })
    .eq("id", runId);

  return NextResponse.json({
    run_id: runId,
    status,
    cursor_to: cursorTo,
    rows_read: rowsRead,
    rows_written: rowsWritten,
    rows_quarantined: rowsQuarantined,
    pages_processed: pagesProcessed,
  });
}
