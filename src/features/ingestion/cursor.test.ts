import { describe, test, expect } from "vitest";
import {
  countersBalance,
  nextCursorTo,
  parseCursor,
  parseRetryAfterMs,
} from "./cursor";

describe("nextCursorTo", () => {
  test("passes the provider's cursor through while more pages remain", () => {
    expect(nextCursorTo(0, 20, "20")).toBe("20");
  });

  test("a drained dataset yields the offset past the last record, never null", () => {
    // The regression this exists for: storing the provider's `next_cursor:
    // null` verbatim made the next run resume from offset 0 and re-read the
    // entire dataset, violating US-01 ("resumes from it, not from scratch")
    // while idempotency hid the data consequence.
    expect(nextCursorTo(180, 20, null)).toBe("200");
  });

  test("a drained short final page still advances by what it actually held", () => {
    expect(nextCursorTo(180, 7, null)).toBe("187");
  });

  test("an empty drained page holds position rather than regressing", () => {
    // What a resumed-at-the-end run sees: no records, no next cursor. The
    // stored cursor must stay where it was so the run after it also resumes
    // at the end.
    expect(nextCursorTo(200, 0, null)).toBe("200");
  });
});

describe("parseCursor", () => {
  test("absent cursor starts at the beginning", () => {
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor(undefined)).toBe(0);
    expect(parseCursor("")).toBe(0);
  });

  test("a numeric cursor is its offset", () => {
    expect(parseCursor("140")).toBe(140);
  });

  test("garbage falls back to the beginning rather than NaN", () => {
    expect(parseCursor("not-a-number")).toBe(0);
    expect(parseCursor("-5")).toBe(0);
  });
});

describe("parseRetryAfterMs", () => {
  test("delta-seconds becomes milliseconds", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
  });

  test("an HTTP-date form yields undefined, not NaN", () => {
    // Retry-After is legally either delta-seconds or an HTTP-date.
    // `Number()` on the date form is NaN, and NaN survives `??`.
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });

  test("absent header yields undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});

describe("countersBalance", () => {
  test("every record read landed in exactly one bucket", () => {
    expect(
      countersBalance({
        rowsRead: 210,
        rowsWritten: 190,
        rowsQuarantined: 10,
        rowsDeduplicated: 10,
      }),
    ).toBe(true);
  });

  test("a silent drop breaks the invariant", () => {
    // This is the shape the tenant-scoped-uniqueness bug produced: records
    // read, nothing written, nothing quarantined, nothing counted as a
    // duplicate — the PRD's "zero silent drops" counter-metric failing.
    expect(
      countersBalance({
        rowsRead: 200,
        rowsWritten: 0,
        rowsQuarantined: 0,
        rowsDeduplicated: 0,
      }),
    ).toBe(false);
  });

  test("a fully deduplicated re-run still balances", () => {
    expect(
      countersBalance({
        rowsRead: 200,
        rowsWritten: 0,
        rowsQuarantined: 0,
        rowsDeduplicated: 200,
      }),
    ).toBe(true);
  });
});
