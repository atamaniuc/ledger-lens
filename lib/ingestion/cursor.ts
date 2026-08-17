// Cursor and circuit-breaker decisions, extracted from the ingestion route
// so they can be unit-tested without a database or a live provider. The
// route's first version inlined both, and both shipped with defects a
// two-line test would have caught — see .claude/DESIGN.md's testing plan.

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
