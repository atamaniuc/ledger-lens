import { z } from "zod";
import { clamp } from "./clamp";
import type { AgentTool } from "./types";

const MAX_ROWS = 20;

const input = z.object({
  status: z.enum(["draft", "open", "paid", "void"]).nullish(),
  // Value bounds live in the body rather than the schema — see ./index.ts.
  customer: z
    .string()
    .nullish()
    .describe("Case-insensitive substring match on the customer name."),
  external_id: z.string().nullish().describe("Exact invoice identifier."),
  limit: z
    .number()
    .int()
    .nullish()
    .describe(`How many invoices to return, at most ${MAX_ROWS}. Defaults to 10.`),
});

export type ListInvoicesInput = z.infer<typeof input>;

export interface ListedInvoice {
  /**
   * The invoice as the world outside this database names it, and what a
   * citation should be written with.
   *
   * Both identifiers are here because both are legitimately useful — the
   * external id to a reader, the row id to the lineage drawer and to a
   * tenant-isolation test that cannot use an external id (the same external id
   * exists in both tenants, which is idempotency working, not a leak). A
   * measured run showed the model citing the row id, so the verifier accepts
   * either now: refusing an id this system handed over was the verifier being
   * wrong (D-25).
   */
  external_id: string;
  /** The internal row id. Not the preferred citation, but a valid one. */
  invoice_id: string;
  customer: string;
  amount_cents: number;
  currency: string;
  status: string;
  issued_at: string;
  paid_at: string | null;
}

export interface ListInvoicesResult {
  invoices: ListedInvoice[];
  /** True when more rows matched than were returned, so an answer can say so. */
  truncated: boolean;
}

export const listInvoices: AgentTool<ListInvoicesInput, ListInvoicesResult> = {
  name: "list_invoices",
  description:
    "Individual invoices for the signed-in user's organization, newest first, optionally " +
    "filtered by status, customer name or exact invoice identifier. Cite invoices by " +
    "external_id. Returns at most 20 rows. " +
    // A measured run had three questions about totals answered by listing rows
    // and adding them up, which is both slower and a different number when the
    // list truncates. Saying where the boundary is costs one sentence.
    "Use get_revenue_summary instead for a total, a count or an average — this tool " +
    "truncates at 20 rows, so summing what it returns is not the organization's total.",
  effect: "read",
  input,

  async execute({ supabase }, args) {
    const limit = clamp(args.limit ?? 10, 1, MAX_ROWS);

    let query = supabase
      .from("invoices")
      .select("id, external_id, customer, amount_cents, currency, status, issued_at, paid_at")
      .order("issued_at", { ascending: false })
      .order("id", { ascending: false })
      // One row past the limit is the "there was more" probe, which costs a
      // row rather than a count over the whole table.
      .limit(limit + 1);

    if (args.status) query = query.eq("status", args.status);
    if (args.external_id) query = query.eq("external_id", args.external_id);
    // `ilike` with the pattern built from an escaped value: PostgREST sends
    // this as a parameter, and the escaping keeps a customer name containing
    // % or _ from turning into a wildcard search.
    if (args.customer) {
      query = query.ilike("customer", `%${args.customer.replace(/[%_\\]/g, "\\$&")}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(`list_invoices failed: ${error.message}`);

    const all = data ?? [];
    const rows = all.slice(0, limit);

    return {
      invoices: rows.map((row) => ({
        external_id: row.external_id,
        invoice_id: row.id,
        customer: row.customer,
        amount_cents: row.amount_cents,
        currency: row.currency,
        status: row.status,
        issued_at: row.issued_at,
        paid_at: row.paid_at,
      })),
      truncated: all.length > limit,
    };
  },
};
