import { describe, test, expect } from "vitest";
import {
  DEFAULT_RUN_BUDGET_MS,
  MAX_RUN_BUDGET_MS,
  MIN_RUN_BUDGET_MS,
  resolveRunBudgetMs,
} from "./budget";

// D-17: the run budget comes from INGEST_BUDGET_MS, never a hardcoded
// literal — and the default must fit the deploy target's serverless
// request limit (the old 45s constant outlived it).

describe("resolveRunBudgetMs", () => {
  test("defaults to a value under a typical serverless request limit", () => {
    expect(DEFAULT_RUN_BUDGET_MS).toBe(25_000);
    // The regression this exists for: the previous hardcoded 45s exceeded
    // several serverless ceilings. The default must be strictly below it.
    expect(DEFAULT_RUN_BUDGET_MS).toBeLessThan(45_000);
  });

  test("reads INGEST_BUDGET_MS from the environment", () => {
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "15000" })).toBe(15_000);
  });

  test("falls back to the default when INGEST_BUDGET_MS is unset", () => {
    expect(resolveRunBudgetMs({})).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "" })).toBe(DEFAULT_RUN_BUDGET_MS);
  });

  test("falls back to the default for an invalid value", () => {
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "not-a-number" })).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "15000.5" })).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "500" })).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "600000" })).toBe(DEFAULT_RUN_BUDGET_MS);
    expect(resolveRunBudgetMs({ INGEST_BUDGET_MS: "-1000" })).toBe(DEFAULT_RUN_BUDGET_MS);
  });

  test("the bounds are coherent", () => {
    expect(MIN_RUN_BUDGET_MS).toBeLessThan(DEFAULT_RUN_BUDGET_MS);
    expect(DEFAULT_RUN_BUDGET_MS).toBeLessThan(MAX_RUN_BUDGET_MS);
  });
});
