import { z } from "zod";
import { formatMoney } from "../../dashboard/metrics";
import type { AgentTool } from "./types";

// The fourth tool, and the only one that is not a read.
//
// It composes text and returns it. There is no mail transport in this
// repository, no queue, no outbound HTTP client and no credential for one —
// the draft is rendered in the chat panel for a person to copy. "Draft only"
// is not a flag on a send capability; the send capability does not exist to
// be flagged (ADR 0009).
//
// The draft is assembled here rather than by the model so that the figures in
// it come from the database, not from the conversation.

const input = z.object({
  external_id: z.string().min(1).max(120).describe("The invoice the email is about."),
  purpose: z
    .enum(["payment_reminder", "dispute_acknowledgement", "receipt_confirmation"])
    .describe("What the email is for."),
  note: z
    .string()
    .max(500)
    .optional()
    .describe("One sentence of context to include, in the sender's own words."),
});

export type DraftCustomerEmailInput = z.infer<typeof input>;

export interface CustomerEmailDraft {
  subject: string;
  body: string;
  /** Stated on every draft so the UI never has to infer it. */
  delivery: "not_sent";
  invoice: {
    /** The row this draft was built from — cite it, and it identifies the tenant. */
    invoice_id: string;
    external_id: string;
    customer: string;
    amount: string;
    status: string;
    issued_at: string;
  };
}

const OPENING: Record<DraftCustomerEmailInput["purpose"], (customer: string) => string> = {
  payment_reminder: (customer) =>
    `Dear ${customer},\n\nThis is a reminder about the invoice below, which is currently outstanding.`,
  dispute_acknowledgement: (customer) =>
    `Dear ${customer},\n\nThank you for raising a query about the invoice below. We have logged it and are reviewing it now.`,
  receipt_confirmation: (customer) =>
    `Dear ${customer},\n\nThank you — we have recorded payment against the invoice below.`,
};

const SUBJECT: Record<DraftCustomerEmailInput["purpose"], (externalId: string) => string> = {
  payment_reminder: (externalId) => `Reminder: invoice ${externalId}`,
  dispute_acknowledgement: (externalId) => `Your query about invoice ${externalId}`,
  receipt_confirmation: (externalId) => `Payment received for invoice ${externalId}`,
};

export const draftCustomerEmail: AgentTool<DraftCustomerEmailInput, CustomerEmailDraft> = {
  name: "draft_customer_email",
  description:
    "Compose a draft email to a customer about one invoice. Returns the draft text only — " +
    "nothing is sent, and this system has no way to send anything. The user copies the draft " +
    "if they want to use it.",
  effect: "draft",
  input,

  async execute({ supabase }, args) {
    const { data, error } = await supabase
      .from("invoices")
      .select("id, external_id, customer, amount_cents, currency, status, issued_at")
      .eq("external_id", args.external_id)
      // Both tenants ingest the same mock dataset, so one `external_id`
      // legitimately exists in more than one org. A user who belongs to two
      // of them sees both rows through RLS, and `maybeSingle` on its own
      // turns a perfectly valid invoice id into a PGRST116 error.
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`draft_customer_email failed: ${error.message}`);
    // Not found and not visible are the same answer here, and deliberately so
    // — distinguishing them would tell one tenant that another's invoice
    // exists.
    if (!data) throw new Error(`no invoice ${args.external_id} is visible to you`);

    const amount = formatMoney(data.amount_cents, data.currency);
    const note = args.note ? `\n\n${args.note}` : "";

    const body =
      `${OPENING[args.purpose](data.customer)}${note}\n\n` +
      `Invoice ${data.external_id}\n` +
      `Amount: ${amount}\n` +
      `Issued: ${data.issued_at}\n` +
      `Status: ${data.status}\n\n` +
      `Kind regards,\nAccounts Receivable`;

    return {
      subject: SUBJECT[args.purpose](data.external_id),
      body,
      delivery: "not_sent",
      invoice: {
        invoice_id: data.id,
        external_id: data.external_id,
        customer: data.customer,
        amount,
        status: data.status,
        issued_at: data.issued_at,
      },
    };
  },
};
