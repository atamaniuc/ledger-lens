import { z } from "zod";
import type { AgentTool } from "./types";

const MAX_ROWS = 20;

const input = z.object({
  status: z.enum(["draft", "open", "paid", "void"]).optional(),
  customer: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Case-insensitive substring match on the customer name."),
  external_id: z.string().min(1).max(120).optional().describe("Exact invoice identifier."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROWS)
    .optional()
    .describe(`How many invoices to return, at most ${MAX_ROWS}. Defaults to 10.`),
});

export type ListInvoicesInput = z.infer<typeof input>;

export interface ListedInvoice {
  invoice_id: string;
  external_id: string;
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
    "external_id. Returns at most 20 rows.",
  effect: "read",
  input,

  async execute({ supabase }, args) {
    const limit = args.limit ?? 10;

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
        invoice_id: row.id,
        external_id: row.external_id,
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
