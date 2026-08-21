// Cursor and circuit-breaker decisions, extracted from the ingestion route
// so they can be unit-tested without a database or a live provider. The
// route's first version inlined both, and both shipped with defects a
// two-line test would have caught.

export const MAX_PAGES_PER_RUN = 20;
export const CONSECUTIVE_FAILURE_LIMIT = 5;

/**
 * The cursor to persist as `pipeline_runs.cursor_to` after a page's records
 * are all written.
 *
 * The provider's cursor is a numeric offset, and it returns
 * `next_cursor: null` once the dataset is drained. Storing that `null`
 * verbatim made the next run resume from offset 0 and re-read everything —
 * idempotency hid the data consequence, but US-01 ("resumes from it, not
 * from scratch") was not met. Instead, a drained page yields the offset
 * just past the last consumed record: resuming there reads nothing today
 * and picks up correctly if the dataset later grows.
 *
 * Invariant: never regress a known offset back to null.
 */
export function nextCursorTo(
  currentOffset: number,
  recordsConsumed: number,
  providerNextCursor: string | null,
): string {
  if (providerNextCursor !== null) return providerNextCursor;
  return String(currentOffset + recordsConsumed);
}

export function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/**
 * `Retry-After` is legally either delta-seconds or an HTTP-date. On a date,
 * `Number()` yields NaN — returning undefined lets the caller fall back to
 * computed backoff rather than passing NaN down into a timer.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export interface RunCounters {
  rowsRead: number;
  rowsWritten: number;
  rowsQuarantined: number;
  rowsDeduplicated: number;
}

/**
 * The invariant that makes the PRD's "zero silent drops" counter-metric
 * checkable instead of merely asserted: every record read must have landed
 * in exactly one of written / quarantined / deduplicated. A record that
 * ends up in none of them is a silent drop, which is precisely the failure
 * mode the original tenant-scoped-uniqueness bug produced.
 */
export function countersBalance(counters: RunCounters): boolean {
  return (
    counters.rowsRead ===
    counters.rowsWritten + counters.rowsQuarantined + counters.rowsDeduplicated
  );
}
// --- run start / refusal (D-12) -------------------------------------------
//
// The polling route now opens its run through public.try_start_polling_run,
// which takes the org's advisory lock, reaps abandoned runs, reads the
// resume cursor and inserts the running row in one transaction. Two
// overlapping starts for the same org are refused with a reason rather than
// crashed into the one-running-per-org index. These constants and the
// parser below are the route's half of that contract, kept pure so the
// "clean refusal, not a crash" guarantee is unit-testable without a
// database (same reason the rest of this file exists).

/** Another start holds the org's advisory lock right now. */
export const RUN_REFUSED_LOCK_BUSY = "advisory_lock_busy";
/** A run for the org is already 'running'. */
export const RUN_REFUSED_ALREADY_RUNNING = "already_running";

export interface RunStart {
  started: boolean;
  /** null when started; otherwise why the start was refused. */
  refused_reason: string | null;
  run_id: string | null;
  cursor_from: string | null;
  /** How many abandoned runs were reaped before the start attempt. */
  reaped: number;
}

/**
 * Interpret the try_start_polling_run RPC result defensively. A malformed
 * payload refuses rather than crashes: a start whose shape cannot be
 * trusted must not open a run on a guess. A reaped count that is not a
 * non-negative number is treated as zero - it is bookkeeping, not a gate.
 */
export function parseRunStart(payload: unknown): RunStart {
  const row = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;

  const reaped =
    typeof row.reaped === "number" && Number.isFinite(row.reaped) && row.reaped >= 0
      ? Math.floor(row.reaped)
      : 0;

  if (row.started !== true || typeof row.run_id !== "string") {
    const reason =
      typeof row.refused_reason === "string" && row.refused_reason.length > 0
        ? row.refused_reason
        : "refused";
    return { started: false, refused_reason: reason, run_id: null, cursor_from: null, reaped };
  }

  return {
    started: true,
    refused_reason: null,
    run_id: row.run_id,
    cursor_from: typeof row.cursor_from === "string" ? row.cursor_from : null,
    reaped,
  };
}
