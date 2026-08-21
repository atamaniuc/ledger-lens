import { describe, expect, it } from "vitest";
import {
  buildDataHealth,
  decodeCursor,
  encodeCursor,
  type RunSummary,
} from "./queries";

const RUN: RunSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "incremental",
  source: "mock-provider",
  status: "succeeded",
  started_at: "2026-08-19T11:00:00.000Z",
  finished_at: "2026-08-19T11:00:30.000Z",
  rows_read: 100,
  rows_written: 90,
  rows_quarantined: 10,
  rows_deduplicated: 0,
};

const check = (
  check_name: string,
  status: string,
  extra: Partial<{ observed: number | null }> = {},
) => ({
  check_name,
  status,
  observed: extra.observed ?? null,
  expected: null,
  delta: null,
  details: null,
});

describe("buildDataHealth", () => {
  it("always renders four cells, in a fixed order", () => {
    const health = buildDataHealth(RUN, []);
    expect(health.cells.map((c) => c.check_name)).toEqual([
      "freshness",
      "volume",
      "uniqueness",
      "reconciliation",
    ]);
  });

  it("distinguishes a missing check from a failing one", () => {
    // A closed run with no result for a check has not passed it and has not
    // failed it. Rendering "missing" as either would be a lie in one
    // direction or the other.
    const health = buildDataHealth(RUN, [check("freshness", "pass")]);
    const [freshness, volume] = health.cells;
    expect(freshness.state).toBe("present");
    expect(volume.state).toBe("missing");
  });

  it("reports a closed run with no results as no verdict, not as a pass", () => {
    // Reachable: the ingestion route catches a checks failure and continues,
    // so a run closes without ever writing a result row.
    const health = buildDataHealth(RUN, []);
    expect(health.noVerdict).toBe(true);
    expect(health.verdict).toBeNull();
  });

  it("takes the newest row when a retried run wrote a check twice", () => {
    // Results accumulate rather than upsert. The caller orders newest-first,
    // so the first occurrence is the one that counts — a later row for the
    // same check is a superseded attempt.
    const health = buildDataHealth(RUN, [
      check("volume", "pass", { observed: 90 }),
      check("volume", "fail", { observed: 5 }),
    ]);
    const volume = health.cells.find((c) => c.check_name === "volume");
    expect(volume?.state === "present" && volume.result.status).toBe("pass");
    expect(volume?.state === "present" && volume.result.observed).toBe(90);
  });

  it("lets one failing check dominate three passes", () => {
    const health = buildDataHealth(RUN, [
      check("freshness", "pass"),
      check("volume", "pass"),
      check("uniqueness", "pass"),
      check("reconciliation", "fail"),
    ]);
    expect(health.verdict).toBe("fail");
  });

  it("does not average a warn away", () => {
    const health = buildDataHealth(RUN, [
      check("freshness", "pass"),
      check("volume", "warn"),
    ]);
    expect(health.verdict).toBe("warn");
  });

  it("reports a verdict from the checks that exist, even when some are missing", () => {
    const health = buildDataHealth(RUN, [check("freshness", "fail")]);
    expect(health.verdict).toBe("fail");
    expect(health.noVerdict).toBe(false);
  });
});

describe("the invoice cursor", () => {
  it("round-trips", () => {
    const cursor = { issuedAt: "2026-08-19T10:00:00.000Z", id: "abc-def" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("survives an id containing the separator", () => {
    // The split is on the first separator only, so the id keeps the rest.
    const cursor = { issuedAt: "2026-08-19T10:00:00.000Z", id: "a|b" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("treats anything malformed as no cursor, starting from the top", () => {
    for (const bad of [null, undefined, "", "no-separator", "|missing-date", "nonsense|id"]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
