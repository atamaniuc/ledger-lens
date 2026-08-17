import { NextRequest, NextResponse } from "next/server";
import { resolveFlags } from "@/lib/mock-provider/chaos";
import { generateDataset, invoiceAmountAsNumber } from "@/lib/mock-provider/data";

// The provider's own aggregate total — independent of /invoices on
// purpose. Always computed from the deduplicated dataset regardless of
// the `duplicates` chaos flag: this is what Stage 3's reconciliation
// check compares against, and reconciling against your own derived data
// (including its duplicates) would prove nothing. See .claude/PRD.md
// "Data Quality & Reconciliation" US-04.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const flags = resolveFlags(searchParams);
  const dataset = generateDataset({ ...flags, duplicates: false });

  const totalAmountCents = dataset.reduce(
    (sum, invoice) => sum + Math.round(invoiceAmountAsNumber(invoice) * 100),
    0,
  );

  return NextResponse.json({
    total_amount_cents: totalAmountCents,
    currency: "USD",
    invoice_count: dataset.length,
    generated_at: new Date().toISOString(),
  });
}
