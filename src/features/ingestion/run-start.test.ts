import { describe, test, expect } from "vitest";
import {
  RUN_REFUSED_ALREADY_RUNNING,
  RUN_REFUSED_LOCK_BUSY,
  parseRunStart,
} from "./cursor";

// D-12: the polling route refuses an overlapping start cleanly instead of
// crashing into the one-running-per-org index. parseRunStart is the route's
// defensive half of that contract - the SQL function (try_start_polling_run)
// is the authoritative half, verified in tests/scheduler-lock.spec.ts against
// the live database.

describe("parseRunStart", () => {
  test("a successful start carries the run id and resume cursor", () => {
    const start = parseRunStart({
      started: true,
      refused_reason: null,
      run_id: "11111111-1111-4111-8111-111111111111",
      cursor_from: "207",
      reaped: 2,
    });
    expect(start.started).toBe(true);
    expect(start.run_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(start.cursor_from).toBe("207");
    expect(start.refused_reason).toBeNull();
    expect(start.reaped).toBe(2);
  });

  test("a run resumed from scratch has a null cursor, which is not an error", () => {
    const start = parseRunStart({
      started: true,
      refused_reason: null,
      run_id: "11111111-1111-4111-8111-111111111111",
      cursor_from: null,
      reaped: 0,
    });
    expect(start.started).toBe(true);
    expect(start.cursor_from).toBeNull();
  });

  test("an already_running refusal keeps its reason", () => {
    const start = parseRunStart({
      started: false,
      refused_reason: RUN_REFUSED_ALREADY_RUNNING,
      run_id: null,
      cursor_from: null,
      reaped: 0,
    });
    expect(start.started).toBe(false);
    expect(start.refused_reason).toBe(RUN_REFUSED_ALREADY_RUNNING);
    expect(start.run_id).toBeNull();
  });

  test("an advisory_lock_busy refusal keeps its reason", () => {
    const start = parseRunStart({
      started: false,
      refused_reason: RUN_REFUSED_LOCK_BUSY,
      run_id: null,
      cursor_from: null,
      reaped: 0,
    });
    expect(start.started).toBe(false);
    expect(start.refused_reason).toBe(RUN_REFUSED_LOCK_BUSY);
  });

  test("a malformed payload refuses rather than throwing", () => {
    // A start whose shape cannot be trusted must not open a run on a guess:
    // null, a string, an empty object, a started row with no run id, and a
    // non-boolean started all refuse with a reason instead of a crash.
    for (const payload of [null, "nope", {}, { started: true }, { started: "yes" }]) {
      const start = parseRunStart(payload);
      expect(start.started, JSON.stringify(payload)).toBe(false);
      expect(start.refused_reason).toBeTruthy();
      expect(start.run_id).toBeNull();
    }
  });

  test("a refusal with no reason still refuses with a default", () => {
    const start = parseRunStart({ started: false, refused_reason: null });
    expect(start.started).toBe(false);
    expect(start.refused_reason).toBe("refused");
  });

  test("a malformed reaped count is zero, not a crash", () => {
    const base = {
      started: true,
      run_id: "11111111-1111-4111-8111-111111111111",
      cursor_from: null,
    };
    for (const reaped of ["2", -1, null, NaN, undefined]) {
      expect(parseRunStart({ ...base, reaped }).reaped).toBe(0);
    }
    expect(parseRunStart({ ...base, reaped: 3.9 }).reaped).toBe(3);
  });
});
