import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";
import {
  AGENT_DAILY_COST_CAP_CENTS_DEFAULT,
  AGENT_DAILY_COST_CAP_CENTS_ENV,
  AGENT_DAILY_TOKEN_CAP_DEFAULT,
  AGENT_DAILY_TOKEN_CAP_ENV,
  AGENT_ORG_RATE_LIMIT_DEFAULT,
  AGENT_ORG_RATE_LIMIT_ENV,
  AGENT_RATE_LIMIT_WINDOW_SECONDS_DEFAULT,
  AGENT_RATE_LIMIT_WINDOW_SECONDS_ENV,
  AGENT_USER_RATE_LIMIT_DEFAULT,
  AGENT_USER_RATE_LIMIT_ENV,
  BudgetError,
  budgetConfig,
  checkAgentBudget,
} from "./budget";

// D-18 + AC-06: the limits are deployment configuration, read from env with
// the same defaults the platform schema will validate at integration. A
// missing or garbage variable must fall back, never crash the route; a
// refusal comes back as a verdict, not as a thrown error.

const ENV_KEYS = [
  AGENT_USER_RATE_LIMIT_ENV,
  AGENT_ORG_RATE_LIMIT_ENV,
  AGENT_RATE_LIMIT_WINDOW_SECONDS_ENV,
  AGENT_DAILY_COST_CAP_CENTS_ENV,
  AGENT_DAILY_TOKEN_CAP_ENV,
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("budgetConfig", () => {
  it("defaults to sane free-tier numbers when nothing is set", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(budgetConfig()).toEqual({
      userRateLimit: AGENT_USER_RATE_LIMIT_DEFAULT,
      orgRateLimit: AGENT_ORG_RATE_LIMIT_DEFAULT,
      windowSeconds: AGENT_RATE_LIMIT_WINDOW_SECONDS_DEFAULT,
      dailyCostCapCents: AGENT_DAILY_COST_CAP_CENTS_DEFAULT,
      dailyTokenCap: AGENT_DAILY_TOKEN_CAP_DEFAULT,
    });
  });

  it("reads every limit from the environment", () => {
    process.env[AGENT_USER_RATE_LIMIT_ENV] = "7";
    process.env[AGENT_ORG_RATE_LIMIT_ENV] = "70";
    process.env[AGENT_RATE_LIMIT_WINDOW_SECONDS_ENV] = "900";
    process.env[AGENT_DAILY_COST_CAP_CENTS_ENV] = "250";
    process.env[AGENT_DAILY_TOKEN_CAP_ENV] = "30000";
    expect(budgetConfig()).toEqual({
      userRateLimit: 7,
      orgRateLimit: 70,
      windowSeconds: 900,
      dailyCostCapCents: 250,
      dailyTokenCap: 30000,
    });
  });

  it("falls back rather than crashing on a non-numeric value", () => {
    process.env[AGENT_USER_RATE_LIMIT_ENV] = "lots";
    process.env[AGENT_DAILY_COST_CAP_CENTS_ENV] = "free";
    const config = budgetConfig();
    expect(config.userRateLimit).toBe(AGENT_USER_RATE_LIMIT_DEFAULT);
    expect(config.dailyCostCapCents).toBe(AGENT_DAILY_COST_CAP_CENTS_DEFAULT);
  });

  it("clamps a configured limit to at least 1 request", () => {
    process.env[AGENT_USER_RATE_LIMIT_ENV] = "0";
    expect(budgetConfig().userRateLimit).toBe(1);
  });

  it("treats a zero daily cap as the cap being disabled", () => {
    process.env[AGENT_DAILY_COST_CAP_CENTS_ENV] = "0";
    expect(budgetConfig().dailyCostCapCents).toBeNull();
  });

  it("treats a zero token cap as the cap being disabled", () => {
    process.env[AGENT_DAILY_TOKEN_CAP_ENV] = "0";
    expect(budgetConfig().dailyTokenCap).toBeNull();
  });
});

describe("checkAgentBudget", () => {
  const ORG = "00000000-0000-4000-8000-000000000001";

  function stubRpc(overrides: {
    data?: unknown;
    error?: { message: string } | null;
  }) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: overrides.data, error: overrides.error ?? null };
      },
    } as unknown as SupabaseClient<Database>;
    return { supabase, calls };
  }

  it("passes the env-configured limits to Postgres and reports an allowed verdict", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env[AGENT_USER_RATE_LIMIT_ENV] = "5";
    const { supabase, calls } = stubRpc({ data: { allowed: true } });

    const verdict = await checkAgentBudget(supabase, ORG);

    expect(verdict).toEqual({ allowed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("check_agent_budget");
    expect(calls[0].args).toMatchObject({
      p_org_id: ORG,
      p_user_limit: 5,
      p_org_limit: AGENT_ORG_RATE_LIMIT_DEFAULT,
      p_window_seconds: AGENT_RATE_LIMIT_WINDOW_SECONDS_DEFAULT,
      p_daily_cost_cap_cents: AGENT_DAILY_COST_CAP_CENTS_DEFAULT,
      p_daily_token_cap: AGENT_DAILY_TOKEN_CAP_DEFAULT,
    });
  });

  it("returns a rate-limit refusal as a verdict with retry_after", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const { supabase } = stubRpc({
      data: {
        allowed: false,
        reason: "rate_limit",
        scope: "user",
        retry_after_seconds: 42,
        resets_at: "2026-08-21T01:00:00+00",
      },
    });

    const verdict = await checkAgentBudget(supabase, ORG);

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("rate_limit");
      expect(verdict.scope).toBe("user");
      expect(verdict.retryAfterSeconds).toBe(42);
      expect(verdict.resetsAt).toBe("2026-08-21T01:00:00+00");
    }
  });

  it("returns a spend-cap refusal as a verdict, not a thrown error", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const { supabase } = stubRpc({
      data: {
        allowed: false,
        reason: "cost_cap",
        retry_after_seconds: 84_000,
        resets_at: "2026-08-22T00:00:00+00",
      },
    });

    const verdict = await checkAgentBudget(supabase, ORG);
    expect(verdict.allowed).toBe(false);
  });

  it("throws BudgetError when Postgres itself fails — a failure, not a refusal", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const { supabase } = stubRpc({ error: { message: "connection refused" } });
    await expect(checkAgentBudget(supabase, ORG)).rejects.toThrow(BudgetError);
  });

  it("throws BudgetError on a malformed verdict rather than misreading it", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const { supabase } = stubRpc({ data: { nope: true } });
    await expect(checkAgentBudget(supabase, ORG)).rejects.toThrow(BudgetError);
  });
});
