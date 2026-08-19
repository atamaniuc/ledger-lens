import { z } from "zod";
import { deriveMetrics } from "../../dashboard/metrics";
import { isoDate } from "./clamp";
import type { AgentTool } from "./types";

const input = z.object({
  status: z
    .enum(["draft", "open", "paid", "void"])
    .nullish()
    .describe("Only count invoices in this status. Omit for every status."),
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
}

export const getRevenueSummary: AgentTool<RevenueSummaryInput, RevenueSummary> = {
  name: "get_revenue_summary",
  description:
    "Total invoiced value, invoice count and average invoice for the signed-in user's " +
    "organization, optionally filtered by status and issue date. Returns invoiced value, " +
    "not recognised revenue. When mixed_currency is true the totals are null and must not " +
    "be reported as a single figure.",
  effect: "read",
  input,

  async execute({ supabase }, args) {
    // No org filter. RLS scopes this to the caller's own organization, the
    // same way it scopes the dashboard tile that shows the same number.
    let query = supabase.from("invoices").select("amount_cents, currency");
    if (args.status) query = query.eq("status", args.status);
    if (args.issued_from) query = query.gte("issued_at", isoDate(args.issued_from, "issued_from"));
    if (args.issued_to) query = query.lte("issued_at", isoDate(args.issued_to, "issued_to"));

    const { data, error } = await query;
    if (error) throw new Error(`get_revenue_summary failed: ${error.message}`);

    const metrics = deriveMetrics(data ?? []);
    return {
      invoice_count: metrics.invoiceCount,
      total_cents: metrics.mixedCurrency ? null : metrics.totalCents,
      average_cents: metrics.mixedCurrency ? null : metrics.averageCents,
      currency: metrics.currency,
      mixed_currency: metrics.mixedCurrency,
      filters: args,
    };
  },
};
