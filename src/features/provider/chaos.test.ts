import { describe, test, expect } from "vitest";
import { chaosEnabledByDefault, resolveFlags, type ChaosFlags } from "./chaos";

// D-16: a production-shaped environment must get a quiet provider — every
// chaos flag OFF by default — while dev/test keeps the failure modes the
// regression suite depends on. The flags themselves are never softened;
// only the default changes, and per-flag overrides still work.

const FLAG_NAMES = [
  "duplicates",
  "schemaDrift",
  "nullFields",
  "rateLimit",
  "serverError",
  "expiredToken",
  "futureDates",
] as const;

function flagValues(flags: ChaosFlags): boolean[] {
  return FLAG_NAMES.map((name) => flags[name]);
}

const PROD_ENV = { APP_ENV: "production", NODE_ENV: "production" };
const DEV_ENV = { APP_ENV: "dev", NODE_ENV: "development" };
const TEST_ENV = { APP_ENV: "test", NODE_ENV: "test" };

describe("chaosEnabledByDefault", () => {
  test("APP_ENV=production means chaos is off", () => {
    expect(chaosEnabledByDefault(PROD_ENV)).toBe(false);
  });

  test("APP_ENV=dev and APP_ENV=test mean chaos is on", () => {
    expect(chaosEnabledByDefault(DEV_ENV)).toBe(true);
    expect(chaosEnabledByDefault(TEST_ENV)).toBe(true);
  });

  test("with no APP_ENV, NODE_ENV=development keeps chaos on for local dev", () => {
    expect(chaosEnabledByDefault({ NODE_ENV: "development" })).toBe(true);
  });

  test("with no APP_ENV and no NODE_ENV, chaos fails closed to off", () => {
    expect(chaosEnabledByDefault({})).toBe(false);
  });

  test("an unknown APP_ENV value is treated as not dev/test", () => {
    expect(chaosEnabledByDefault({ APP_ENV: "staging" })).toBe(false);
  });
});

describe("resolveFlags under a production-shaped environment (AC-04)", () => {
  test("every chaos flag defaults to OFF when APP_ENV=production", () => {
    const flags = resolveFlags(new URLSearchParams(), PROD_ENV);
    expect(flagValues(flags).every((value) => value === false)).toBe(true);
  });

  test("every chaos flag defaults to ON when APP_ENV=dev", () => {
    const flags = resolveFlags(new URLSearchParams(), DEV_ENV);
    expect(flagValues(flags).every((value) => value === true)).toBe(true);
  });

  test("a per-flag env override still works in production", () => {
    const flags = resolveFlags(new URLSearchParams(), {
      ...PROD_ENV,
      CHAOS_RATE_LIMIT: "true",
    });
    expect(flags.rateLimit).toBe(true);
    expect(flags.duplicates).toBe(false);
  });

  test("a per-request query param still works in production", () => {
    const flags = resolveFlags(new URLSearchParams({ rateLimit: "true" }), PROD_ENV);
    expect(flags.rateLimit).toBe(true);
    expect(flags.duplicates).toBe(false);
  });

  test("a per-flag env override can turn a flag off in dev", () => {
    const flags = resolveFlags(new URLSearchParams(), {
      ...DEV_ENV,
      CHAOS_SERVER_ERROR: "false",
    });
    expect(flags.serverError).toBe(false);
    expect(flags.duplicates).toBe(true);
  });

  test("chaosEnabledByDefault does not consume a flag's own env var", () => {
    // CHAOS_* vars must never decide whether chaos is on at all — only
    // APP_ENV/NODE_ENV decide the default; CHAOS_* tunes individual flags.
    expect(chaosEnabledByDefault({ CHAOS_DUPLICATES: "true" })).toBe(false);
  });
});
