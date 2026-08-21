// D-18: the request budgets and the daily cost cap for /api/agent/chat.
//
// Everything about *where the line is* lives here and comes from the
// environment (AC-06 / D-21 pattern) — never a constant in the route. The
// *counting* lives in Postgres (migration 20260821100000), because the app
// runs on Vercel where process memory is per-instance and resets: a counter
// kept here would drift apart between instances and reset on every cold
// start, which is exactly the limit a determined account could then walk
// around.
//
// The variables are validated in src/platform/config.ts at integration (this
// lane does not own that file); the defaults below are the same values, so
// this module and the schema can never disagree about what a missing
// variable means.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";

/** Requests one user may make per window. */
export const AGENT_USER_RATE_LIMIT_ENV = "AGENT_USER_RATE_LIMIT";
/** Requests one org may make per window, across all its users. */
export const AGENT_ORG_RATE_LIMIT_ENV = "AGENT_ORG_RATE_LIMIT";
/** Length of the fixed rate-limit window, in seconds. */
export const AGENT_RATE_LIMIT_WINDOW_SECONDS_ENV = "AGENT_RATE_LIMIT_WINDOW_SECONDS";
/** Daily spend cap in cents, from llm_calls.cost_cents. 0 disables the cap. */
export const AGENT_DAILY_COST_CAP_CENTS_ENV = "AGENT_DAILY_COST_CAP_CENTS";
/**
 * Daily token budget per org, summed from llm_calls. 0 disables it. Counts
 * tokens rather than cents because a free-tier model records cost 0 while it
 * still burns the provider's quota — this is the guard that cannot be
 * bypassed by pointing the copilot at a zero-cost model (D-52).
 */
export const AGENT_DAILY_TOKEN_CAP_ENV = "AGENT_DAILY_TOKEN_CAP";

export const AGENT_USER_RATE_LIMIT_DEFAULT = 60;
export const AGENT_ORG_RATE_LIMIT_DEFAULT = 300;
export const AGENT_RATE_LIMIT_WINDOW_SECONDS_DEFAULT = 60 * 60;
export const AGENT_DAILY_COST_CAP_CENTS_DEFAULT = 1_000; // $10.00
export const AGENT_DAILY_TOKEN_CAP_DEFAULT = 200_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

/** The daily cap in cents, or null when the cap is disabled (0). */
function dailyCapCents(): number | null {
  const raw = process.env[AGENT_DAILY_COST_CAP_CENTS_ENV];
  if (raw === undefined || raw.trim() === "") return AGENT_DAILY_COST_CAP_CENTS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return AGENT_DAILY_COST_CAP_CENTS_DEFAULT;
  if (parsed <= 0) return null;
  return parsed;
}

export interface BudgetConfig {
  userRateLimit: number;
  orgRateLimit: number;
  windowSeconds: number;
  dailyCostCapCents: number | null;
  dailyTokenCap: number | null;
}

/** The whole budget configuration, for tests and for the route in one read. */
export function budgetConfig(): BudgetConfig {
  return {
    userRateLimit: positiveIntFromEnv(AGENT_USER_RATE_LIMIT_ENV, AGENT_USER_RATE_LIMIT_DEFAULT),
    orgRateLimit: positiveIntFromEnv(AGENT_ORG_RATE_LIMIT_ENV, AGENT_ORG_RATE_LIMIT_DEFAULT),
    windowSeconds: positiveIntFromEnv(
      AGENT_RATE_LIMIT_WINDOW_SECONDS_ENV,
      AGENT_RATE_LIMIT_WINDOW_SECONDS_DEFAULT,
    ),
    dailyCostCapCents: dailyCapCents(),
    dailyTokenCap: dailyTokenCap(),
  };
}

/** The daily token budget, or null when disabled (0). */
function dailyTokenCap(): number | null {
  const raw = process.env[AGENT_DAILY_TOKEN_CAP_ENV];
  if (raw === undefined || raw.trim() === "") return AGENT_DAILY_TOKEN_CAP_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return AGENT_DAILY_TOKEN_CAP_DEFAULT;
  if (parsed <= 0) return null;
  return Math.floor(parsed);
}

export type BudgetVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "rate_limit" | "cost_cap" | "token_cap";
      scope?: "user" | "org";
      /** Seconds until the window resets; always at least 1. */
      retryAfterSeconds: number;
      /** When the window resets, as an ISO timestamp — the 402/429 names it. */
      resetsAt: string;
    };

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

// The generated Database types do not know the budget RPC yet (they are
// regenerated from the schema at integration). Call it through a narrow,
// locally typed channel so the rest of the codebase stays fully typed.
interface BudgetRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

/**
 * Asks Postgres whether this request may proceed. Counts the request against
 * the per-user and per-org windows and checks the org's spend so far today,
 * in one atomic call — so two instances never double-count or race past a
 * limit. Throws BudgetError only on a transport/database failure, never for
 * a refusal: a refusal is a verdict, and the caller maps it to 429/402.
 */
export async function checkAgentBudget(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<BudgetVerdict> {
  const config = budgetConfig();
  const { data, error } = await (supabase as unknown as BudgetRpc).rpc("check_agent_budget", {
    p_org_id: orgId,
    p_user_limit: config.userRateLimit,
    p_org_limit: config.orgRateLimit,
    p_window_seconds: config.windowSeconds,
    p_daily_cost_cap_cents: config.dailyCostCapCents,
    p_daily_token_cap: config.dailyTokenCap,
  });

  if (error) throw new BudgetError(`check_agent_budget failed: ${error.message}`);

  // The database returns snake_case; the route reads camelCase. The
  // database is the authority, so a malformed answer is a bug to surface,
  // not a limit to paper over with a generic error.
  const raw = data as {
    allowed?: boolean;
    reason?: "rate_limit" | "cost_cap" | "token_cap";
    scope?: "user" | "org";
    retry_after_seconds?: number;
    resets_at?: string;
  } | null;
  if (!raw || typeof raw !== "object" || raw.allowed === undefined) {
    throw new BudgetError(`check_agent_budget returned an unexpected shape`);
  }
  if (raw.allowed) return { allowed: true };
  if (!raw.reason || typeof raw.retry_after_seconds !== "number") {
    throw new BudgetError(`check_agent_budget returned a refusal without retry_after`);
  }
  return {
    allowed: false,
    reason: raw.reason,
    scope: raw.scope,
    retryAfterSeconds: raw.retry_after_seconds,
    resetsAt: raw.resets_at ?? "",
  };
}
