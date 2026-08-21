import { describe, expect, test } from "vitest";
import { CHECK_NAMES, worstStatus, type CheckResult } from "./constants";

const result = (check_name: CheckResult["check_name"], status: CheckResult["status"]): CheckResult => ({
  check_name,
  status,
  observed: null,
  expected: null,
  delta: null,
  details: null,
});

describe("worstStatus", () => {
  test("all passing is a pass", () => {
    expect(worstStatus(CHECK_NAMES.map((n) => result(n, "pass")))).toBe("pass");
  });

  test("one warn among passes is a warn", () => {
    expect(
      worstStatus([
        result("freshness", "pass"),
        result("volume", "warn"),
        result("uniqueness", "pass"),
        result("reconciliation", "pass"),
      ]),
    ).toBe("warn");
  });

  // The one that matters: a single failure must not be averaged away by
  // three passes. A run whose reconciliation failed is a failed run.
  test("one fail dominates three passes", () => {
    expect(
      worstStatus([
        result("freshness", "pass"),
        result("volume", "pass"),
        result("uniqueness", "pass"),
        result("reconciliation", "fail"),
      ]),
    ).toBe("fail");
  });

  test("fail dominates warn", () => {
    expect(worstStatus([result("volume", "warn"), result("reconciliation", "fail")])).toBe("fail");
  });

  // An empty set is not a passing set — but the route reports emptiness
  // through `complete`, not through the status, so this pins the behaviour
  // rather than endorsing it as a verdict.
  test("an empty set reports pass, and completeness is signalled separately", () => {
    expect(worstStatus([])).toBe("pass");
  });

  test("the four check names are exactly the ones the migration constrains", () => {
    expect([...CHECK_NAMES]).toEqual(["freshness", "volume", "uniqueness", "reconciliation"]);
  });
});
