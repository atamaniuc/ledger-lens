import { describe, expect, it } from "vitest";
import { demoAnswer, demoFallbackAnswer } from "./demo-answer";
import type { ToolContext } from "./tools/types";

// The demo path (D-53) must answer from REAL data through the REAL tools, and
// mark every answer so the panel can say so. A stub context that returns
// deterministic tool data keeps these tests model-free and fast.

function stubCtx(rows: unknown): ToolContext {
  const builder = {
    eq: () => builder,
    gte: () => builder,
    lte: () => builder,
    limit: () => builder,
    order: () => builder,
    then: undefined,
  } as unknown as Record<string, unknown> & PromiseLike<{ data: unknown; error: null }>;
  (builder as { then: unknown }).then = (
    resolve: (value: { data: unknown; error: null }) => void,
  ) => resolve({ data: rows, error: null });

  const from = (table: string) => {
    if (table === "chunks") {
      return {
        select: () => ({
          in: () => builder,
        }),
      };
    }
    return { select: () => builder };
  };
  return {
    supabase: { from } as unknown as ToolContext["supabase"],
    orgId: "org",
    correlationId: "corr",
  };
}

describe("demoAnswer", () => {
  it("answers revenue questions from real numbers, cited", async () => {
    const answer = await demoAnswer(
      "what is our total revenue?",
      stubCtx([
        { external_id: "inv-1", amount_cents: 1000, currency: "USD" },
        { external_id: "inv-2", amount_cents: 2000, currency: "USD" },
      ]),
    );
    expect(answer?.demo).toBe(true);
    expect(answer?.answer).toContain("USD 30"); // 3000 cents
    expect(answer?.answer).toContain("[inv-2]");
    expect(answer?.citedInvoiceIds).toContain("inv-2");
  });

  it("answers overdue questions through list_invoices", async () => {
    const answer = await demoAnswer(
      "are any invoices overdue?",
      stubCtx([
        { external_id: "inv-open", amount_cents: 500, currency: "USD", status: "open" },
      ]),
    );
    expect(answer?.demo).toBe(true);
    expect(answer?.answer).toContain("1 invoice(s) are currently open");
    expect(answer?.toolsUsed).toEqual(["list_invoices"]);
  });

  it("returns null for an unknown shape, so the caller can fall back", async () => {
    const answer = await demoAnswer("tell me a joke", stubCtx([]));
    expect(answer).toBeNull();
  });

  it("the fallback answer names the shapes it understands", () => {
    const answer = demoFallbackAnswer();
    expect(answer.demo).toBe(true);
    expect(answer.answer).toContain("total revenue");
    expect(answer.answer).toContain("overdue");
  });
});
