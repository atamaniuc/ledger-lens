// D-17: the ingestion run's wall-clock budget. The polling route used to
// hardcode 45 seconds, which outlives several serverless request limits;
// this resolves the budget from INGEST_BUDGET_MS (milliseconds) with a
// default that fits the deploy target (Vercel: 60s default function
// limit — 25s leaves headroom for upstream retries inside the
// invocation). Pure env resolution, no I/O, so the route can import it
// without a build step.
//
// Ownership note: this file is new and lives next to the other shared
// ingestion modules so the route (src/app/api/ingestion/run/route.ts,
// lane W2-B) can swap its `const RUN_BUDGET_MS = 45_000` literal for
// `resolveRunBudgetMs()`. The parent should add
// `INGEST_BUDGET_MS: z.coerce.number().int().positive().max(300_000).default(25_000)`
// to src/platform/config.ts and expose a typed getter.

/** Default budget: 25s, under a typical 30–60s serverless request limit. */
export const DEFAULT_RUN_BUDGET_MS = 25_000;
/** Floor: below this a run cannot even fetch one page with retries. */
export const MIN_RUN_BUDGET_MS = 1_000;
/** Ceiling: no single invocation should run longer than 5 minutes. */
export const MAX_RUN_BUDGET_MS = 300_000;

export function resolveRunBudgetMs(
  source: Record<string, string | undefined> = process.env,
): number {
  const raw = source.INGEST_BUDGET_MS;
  if (raw === undefined || raw === "") return DEFAULT_RUN_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_RUN_BUDGET_MS || parsed > MAX_RUN_BUDGET_MS) {
    return DEFAULT_RUN_BUDGET_MS;
  }
  return parsed;
}
