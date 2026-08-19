import { describe, expect, it } from "bun:test";
import {
  FRESHNESS_THRESHOLD_MS,
  classifyFreshness,
  formatAge,
} from "./freshness";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("classifyFreshness", () => {
  it("is fresh well inside the threshold", () => {
    const result = classifyFreshness(ago(30 * 60_000), NOW);
    expect(result.state).toBe("fresh");
  });

  it("is fresh exactly at the threshold", () => {
    // The boundary has to fall on one side. A badge that flips a millisecond
    // early helps nobody, so the threshold itself is still fresh.
    expect(classifyFreshness(ago(FRESHNESS_THRESHOLD_MS), NOW).state).toBe("fresh");
  });

  it("is stale one millisecond past the threshold", () => {
    expect(classifyFreshness(ago(FRESHNESS_THRESHOLD_MS + 1), NOW).state).toBe("stale");
  });

  it("reports no rows as empty, not stale", () => {
    // A tenant who has not ingested yet is not out of date. Telling them so
    // is a false alarm, and the empty state names the next action instead.
    expect(classifyFreshness(null, NOW).state).toBe("empty");
  });

  it("reports an unparseable timestamp as unknown, never fresh", () => {
    expect(classifyFreshness("not a date", NOW).state).toBe("unknown");
  });

  it("has no input that defaults to fresh", () => {
    // The counter-metric in one assertion: every degenerate input lands on a
    // state that says something is wrong, not on the reassuring one.
    for (const input of [null, "", "nonsense", "0000-13-45T99:99:99Z"]) {
      expect(classifyFreshness(input as string | null, NOW).state).not.toBe("fresh");
    }
  });

  it("carries the age so the badge can say how old", () => {
    const result = classifyFreshness(ago(90 * 60_000), NOW);
    expect(result.state === "fresh" && result.ageMs).toBe(90 * 60_000);
  });
});

describe("formatAge", () => {
  it("renders a negative age as 'just now' rather than a time in the future", () => {
    // Clock skew between the browser and Postgres is real; "in 3 minutes"
    // reads as a bug.
    expect(formatAge(-5_000)).toBe("just now");
  });

  it("singularises", () => {
    expect(formatAge(60_000)).toBe("1 minute ago");
    expect(formatAge(2 * 60_000)).toBe("2 minutes ago");
    expect(formatAge(60 * 60_000)).toBe("1 hour ago");
    expect(formatAge(25 * 60 * 60_000)).toBe("1 day ago");
  });
});
