import type { APIRequestContext } from "@playwright/test";

// Typed wrappers for the two authenticated entry points, so specs assert on
// named fields instead of indexing into `any` — which is the whole reason
// these tests are TypeScript rather than curl and jq.

export interface IngestionRun {
  run_id: string;
  correlation_id: string;
  status: "succeeded" | "failed";
  cursor_to: string | null;
  rows_read: number;
  rows_written: number;
  rows_quarantined: number;
  rows_deduplicated: number;
  counters_balanced: boolean;
  pages_processed: number;
  error: string | null;
  data_quality: QualityVerdict | null;
}

export interface CheckRow {
  check_name: "freshness" | "volume" | "uniqueness" | "reconciliation";
  status: "pass" | "warn" | "fail";
  observed: number | null;
  expected: number | null;
  delta: number | null;
  details: Record<string, unknown> | null;
}

export interface QualityVerdict {
  overall: "pass" | "warn" | "fail";
  complete: boolean;
  provider: { total_amount_cents: number; invoice_count: number };
  results: CheckRow[];
}

export interface ProviderPage {
  data: { external_id: string; amount: number | string; customer: string | null }[];
  next_cursor: string | null;
}

export interface ProviderSummary {
  total_amount_cents: number;
  currency: string;
  invoice_count: number;
}

function secret(): string {
  const s = process.env.INGESTION_TRIGGER_SECRET;
  if (!s) throw new Error("INGESTION_TRIGGER_SECRET missing from .env.local");
  return s;
}

export const authed = () => ({ "x-ingestion-secret": secret() });

export async function ingest(
  request: APIRequestContext,
  orgId: string,
): Promise<IngestionRun> {
  const res = await request.post("/api/ingestion/run", {
    headers: authed(),
    data: { org_id: orgId },
  });
  if (!res.ok()) throw new Error(`ingestion returned ${res.status()}: ${await res.text()}`);
  return (await res.json()) as IngestionRun;
}

export async function checkQuality(
  request: APIRequestContext,
  orgId: string,
  runId?: string,
): Promise<QualityVerdict & { run_id: string | null }> {
  const res = await request.post("/api/data-quality/run", {
    headers: authed(),
    data: runId ? { org_id: orgId, run_id: runId } : { org_id: orgId },
  });
  if (!res.ok()) throw new Error(`checks returned ${res.status()}: ${await res.text()}`);
  return await res.json();
}

/** Picks one check out of a verdict, failing loudly rather than returning undefined. */
export function check(verdict: { results: CheckRow[] }, name: CheckRow["check_name"]): CheckRow {
  const row = verdict.results.find((r) => r.check_name === name);
  if (!row) {
    throw new Error(
      `no '${name}' result — got [${verdict.results.map((r) => r.check_name).join(", ")}]`,
    );
  }
  return row;
}

/**
 * All seven chaos flags off, except the ones named.
 *
 * The route reads each flag with searchParams.get(), which returns the FIRST
 * occurrence — so a flag cannot be re-enabled by appending it to an all-off
 * string. It has to be left out of that string entirely. Getting this wrong
 * silently disabled three chaos assertions in the shell version.
 */
export function flagsOffExcept(...keep: string[]): Record<string, string> {
  const all = [
    "duplicates", "schemaDrift", "nullFields",
    "rateLimit", "serverError", "expiredToken", "futureDates",
  ];
  return Object.fromEntries(
    all.filter((f) => !keep.includes(f)).map((f) => [f, "false"]),
  );
}
