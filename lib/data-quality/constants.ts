// Shared shapes for the Stage 3 data-quality checks.
//
// Deliberately no thresholds here. The numbers live in exactly one place —
// public.run_data_quality_checks — because they are applied there, and a
// copy in TypeScript would be a second source of truth that nothing keeps
// in sync. The boundary behaviour is verified against the live function in
// scripts/smoke.sh rather than against a duplicate of it.

export const CHECK_NAMES = ["freshness", "volume", "uniqueness", "reconciliation"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type CheckStatus = "pass" | "warn" | "fail";

// The row shape run_data_quality_checks returns. Hand-written for the same
// reason IngestOutcome is: generated types do not cover function return
// shapes, so supabase.rpc() is otherwise untyped.
export interface CheckResult {
  check_name: CheckName;
  status: CheckStatus;
  observed: number | null;
  expected: number | null;
  delta: number | null;
  details: Record<string, unknown> | null;
}

// A run's overall verdict: the worst status among its checks. `fail`
// dominates `warn` dominates `pass`, so one failing check cannot be
// averaged away by three passing ones.
export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "pass";
}
