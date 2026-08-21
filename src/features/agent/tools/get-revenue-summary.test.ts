import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_IDS } from "./get-revenue-summary";
import { getRevenueSummary } from "./get-revenue-summary";

// A summary that cannot name what it summed is the failure this project argues
// against, and it was also a structural hole in the eval suite: more than half
// the citation-validity cases ask for a revenue figure, and while the tool
// returned only a total, a fully compliant answer was still unverifiable —
// the 0.95 bar was unreachable by construction (D-25).

interface Row {
  external_id: string;
  amount_cents: number;
  currency: string;
}

function stubClient(rows: Row[]) {
  const builder = {
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    then: undefined,
  } as unknown as Record<string, unknown> & PromiseLike<{ data: Row[]; error: null }>;
  (builder as { then: unknown }).then = (resolve: (value: { data: Row[]; error: null }) => void) =>
    resolve({ data: rows, error: null });
  return {
    from: () => ({ select: () => builder }),
  } as unknown as Parameters<typeof getRevenueSummary.execute>[0]["supabase"];
}

const ctx = (rows: Row[]) =>
  ({ supabase: stubClient(rows), orgId: "org", correlationId: "corr" }) as unknown as Parameters<
    typeof getRevenueSummary.execute
  >[0];

describe("get_revenue_summary evidence", () => {
  it("names the invoices behind the figure, largest first", async () => {
    const result = await getRevenueSummary.execute(
      ctx([
        { external_id: "inv-small", amount_cents: 100, currency: "USD" },
        { external_id: "inv-big", amount_cents: 900, currency: "USD" },
        { external_id: "inv-mid", amount_cents: 500, currency: "USD" },
      ]),
      {},
    );
    expect(result.total_cents).toBe(1500);
    expect(result.evidence_invoice_ids).toEqual(["inv-big", "inv-mid", "inv-small"]);
    expect(result.evidence_truncated).toBe(false);
  });

  it("caps the evidence and says it did", async () => {
    const rows = Array.from({ length: MAX_EVIDENCE_IDS + 5 }, (_, i) => ({
      external_id: `inv-${i}`,
      amount_cents: 1000 - i,
      currency: "USD",
    }));
    const result = await getRevenueSummary.execute(ctx(rows), {});
    expect(result.evidence_invoice_ids).toHaveLength(MAX_EVIDENCE_IDS);
    expect(result.evidence_truncated).toBe(true);
    expect(result.invoice_count).toBe(rows.length);
  });

  it("returns no evidence and no total when there is nothing to summarise", async () => {
    const result = await getRevenueSummary.execute(ctx([]), {});
    expect(result.invoice_count).toBe(0);
    expect(result.evidence_invoice_ids).toEqual([]);
    expect(result.evidence_truncated).toBe(false);
  });

  it("still refuses a single figure across currencies, but can still attribute it", async () => {
    const result = await getRevenueSummary.execute(
      ctx([
        { external_id: "inv-usd", amount_cents: 100, currency: "USD" },
        { external_id: "inv-eur", amount_cents: 200, currency: "EUR" },
      ]),
      {},
    );
    expect(result.mixed_currency).toBe(true);
    expect(result.total_cents).toBeNull();
    expect(result.evidence_invoice_ids).toEqual(["inv-eur", "inv-usd"]);
  });
});
