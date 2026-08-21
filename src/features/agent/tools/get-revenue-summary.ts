import { z } from "zod";
import { deriveMetrics } from "@/features/dashboard/metrics";
import { isoDate } from "./clamp";
import type { AgentTool } from "./types";

const input = z.object({
  status: z
    .enum(["draft", "open", "paid", "void"])
    .nullish()
    .describe(
      "Only count invoices in this status. Omit it unless the question named a status — " +
        "an average over open invoices only is a different figure from the average the " +
        "dashboard shows.",
    ),
  // The date format is checked in the body, not by the schema — see
  // ./index.ts. A malformed date should come back to the model as a tool
  // error it can correct, not as a rejected request that ends the turn.
  issued_from: z
    .string()
    .nullish()
    .describe("Only count invoices issued on or after this date (YYYY-MM-DD)."),
  issued_to: z
    .string()
    .nullish()
    .describe("Only count invoices issued on or before this date (YYYY-MM-DD)."),
});

export type RevenueSummaryInput = z.infer<typeof input>;

export interface RevenueSummary {
  invoice_count: number;
  /**
   * `null` when the rows span more than one currency. Summing across
   * currencies is arithmetic on incomparable units, and a model handed a
   * number will quote it — so it is not handed one.
   */
  total_cents: number | null;
  average_cents: number | null;
  currency: string | null;
  mixed_currency: boolean;
  /** Echoed back so an answer can state what it actually counted. */
  filters: RevenueSummaryInput;
  /**
   * The invoices this figure is made of, largest first, so an answer can
   * attribute the number instead of asserting it.
   *
   * This exists because the eval suite made a structural gap visible: more than
   * half the citation-validity cases ask for a revenue figure, and a tool that
   * returned only the total made a *fully compliant* answer unverifiable — the
   * 0.95 bar was unreachable by construction, not by the model's fault (D-25).
   * A summary that cannot name what it summed is also the exact failure this
   * project argues against, so the fix belongs in the tool, not in the bar.
   */
  evidence_invoice_ids: string[];
  /** True when the figure covers more invoices than the ids listed above. */
  evidence_truncated: boolean;
}

/** How many contributing invoice ids come back as citable evidence. */
export const MAX_EVIDENCE_IDS = 20;

export const getRevenueSummary: AgentTool<RevenueSummaryInput, RevenueSummary> = {
  name: "get_revenue_summary",
  description:
    "The answer to any question about a total, a count or an average: total invoiced value, " +
    "invoice count and average invoice for the signed-in user's organization, optionally " +
    "filtered by status and issue date. Prefer this over listing invoices and adding them " +
    "up, which truncates. Returns invoiced value, " +
    "not recognised revenue. When mixed_currency is true the totals are null and must not " +
    "be reported as a single figure. evidence_invoice_ids lists the largest contributing " +
    "invoices — cite one or more of them as [invoice:ID] to attribute the figure.",
  effect: "read",
  input,

  async execute({ supabase }, args) {
    // No org filter. RLS scopes this to the caller's own organization, the
    // same way it scopes the dashboard tile that shows the same number.
    let query = supabase.from("invoices").select("external_id, amount_cents, currency");
    if (args.status) query = query.eq("status", args.status);
    if (args.issued_from) query = query.gte("issued_at", isoDate(args.issued_from, "issued_from"));
    if (args.issued_to) query = query.lte("issued_at", isoDate(args.issued_to, "issued_to"));

    const { data, error } = await query;
    if (error) throw new Error(`get_revenue_summary failed: ${error.message}`);

    const rows = data ?? [];
    const metrics = deriveMetrics(rows);
    // Largest first: if an answer cites a handful, the handful that matters
    // most to the total is the one worth naming.
    const evidence = [...rows]
      .sort((a, b) => (b.amount_cents ?? 0) - (a.amount_cents ?? 0))
      .slice(0, MAX_EVIDENCE_IDS)
      .map((row) => row.external_id);

    return {
      invoice_count: metrics.invoiceCount,
      total_cents: metrics.mixedCurrency ? null : metrics.totalCents,
      average_cents: metrics.mixedCurrency ? null : metrics.averageCents,
      currency: metrics.currency,
      mixed_currency: metrics.mixedCurrency,
      filters: args,
      evidence_invoice_ids: evidence,
      evidence_truncated: rows.length > evidence.length,
    };
  },
};
