import { z } from "zod";

// Shared verbatim by the polling ingestion route (Next.js) and the
// provider-webhook Deno Edge Function — see ADR 0002 and the
// "Ingestion & Transform" PRD entry. Pure validation logic, no I/O, so it
// can be imported by relative path from both runtimes without a build
// step (ADR 0002).

const rawInvoiceSchema = z.object({
  external_id: z.string().min(1),
  // A null customer (nullFields chaos) fails z.string() — quarantined,
  // per PRD US-04. Not optional: a missing field is also a failure.
  customer: z.string().min(1),
  // schemaDrift chaos turns amount into a numeric string mid-stream —
  // tolerated here, not rejected, per the Mock Provider PRD's schema
  // tolerance requirement. Only a non-numeric value fails.
  amount: z.union([z.number(), z.string()]),
  currency: z.literal("USD"),
  status: z.enum(["draft", "open", "paid", "void"]),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});

interface TransformedInvoice {
  external_id: string;
  customer: string;
  amount_cents: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void";
  issued_at: string;
}

export type TransformResult =
  | { ok: true; invoice: TransformedInvoice }
  | { ok: false; reason: string; details?: unknown };

export interface TransformOptions {
  /**
   * The reference "today" for the future-dates rule, compared as a UTC date
   * (YYYY-MM-DD). Injectable so tests are deterministic; defaults to now.
   */
  today?: Date;
}

export function validateInvoice(raw: unknown, options: TransformOptions = {}): TransformResult {
  const parsed = rawInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `schema_validation_failed: ${reason}`, details: parsed.error.flatten() };
  }

  const amountNumber =
    typeof parsed.data.amount === "string" ? Number.parseFloat(parsed.data.amount) : parsed.data.amount;
  if (!Number.isFinite(amountNumber) || amountNumber < 0) {
    return { ok: false, reason: `invalid_amount: ${String(parsed.data.amount)}` };
  }

  // D-15: the format-only Zod check above passes a future-dated invoice
  // (the `futureDates` chaos flag) and lets an impossible date quietly
  // inflate every metric. The honest rule is the one every other invalid
  // record gets: quarantine with a reason. Issued today is fine; strictly
  // after today (UTC) is not. String comparison is safe because the schema
  // already pinned the format to YYYY-MM-DD.
  const today = (options.today ?? new Date()).toISOString().slice(0, 10);
  if (parsed.data.issued_at > today) {
    return {
      ok: false,
      reason: `future_dated: issued_at=${parsed.data.issued_at} is after today (${today})`,
      details: { issued_at: parsed.data.issued_at, today },
    };
  }

  return {
    ok: true,
    invoice: {
      external_id: parsed.data.external_id,
      customer: parsed.data.customer,
      amount_cents: Math.round(amountNumber * 100),
      currency: parsed.data.currency,
      status: parsed.data.status,
      issued_at: parsed.data.issued_at,
    },
  };
}
