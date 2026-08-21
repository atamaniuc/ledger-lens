import type { SupabaseClient } from "@supabase/supabase-js";
import { CHECK_NAMES, worstStatus, type CheckResult, type CheckStatus } from "./constants";

// The Stage 3 checks, in one place so the standalone route and the end of an
// ingestion run invoke exactly the same thing. Having the ingestion route
// POST to the other route instead would work, but it would mean an HTTP hop
// to itself and a second place that has to know the shared secret.

export interface ProviderSummary {
  total_amount_cents: number;
  invoice_count: number;
}

export interface RunChecksOutcome {
  overall: CheckStatus;
  complete: boolean;
  provider: ProviderSummary;
  results: CheckResult[];
}

export async function fetchProviderSummary(baseUrl: string): Promise<ProviderSummary> {
  const res = await fetch(new URL("/api/mock-provider/summary", baseUrl));
  if (!res.ok) throw new Error(`provider returned ${res.status}`);
  const summary = (await res.json()) as ProviderSummary;
  // Checked rather than trusted: a malformed number reaches Postgres as a
  // cast error and surfaces as a bare 500 several layers from its cause.
  if (typeof summary.total_amount_cents !== "number" || !Number.isFinite(summary.total_amount_cents)) {
    throw new Error("provider summary missing a usable total_amount_cents");
  }
  return summary;
}

export async function runChecks(
  supabase: SupabaseClient,
  opts: {
    orgId: string;
    runId: string | null;
    summary: ProviderSummary;
  },
): Promise<RunChecksOutcome> {
  const { data, error } = await supabase.rpc("run_data_quality_checks", {
    p_org_id: opts.orgId,
    p_run_id: opts.runId,
    p_provider_total_cents: opts.summary.total_amount_cents,
    p_provider_invoice_count: opts.summary.invoice_count,
  });
  if (error) throw new Error(error.message);

  const results = (data ?? []) as CheckResult[];
  return {
    overall: worstStatus(results),
    // A short set means a check silently did not run — a different problem
    // from a check failing, and one that otherwise reads as a clean pass.
    complete: results.length === CHECK_NAMES.length,
    provider: opts.summary,
    results,
  };
}
