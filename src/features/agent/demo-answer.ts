// The demo-mode answer path (D-53).
//
// When the operator turns on demo mode, the copilot NEVER shows a
// rate-limit error. If no provider can answer — unconfigured, daily quota
// spent, rate-limited — the route answers deterministically from this
// tenant's real data, through the SAME tools the agent would use. The
// answer is real, cited, and marked `demo: true` so the panel can say so.
//
// This exists because a presentation must not end with "try again in about
// 27 minutes". It is explicitly a demo affordance, gated by an operator
// setting, and the safety model is unchanged: the tools still run under the
// caller's JWT and RLS still decides what they see.

import type { AgentTurnResult } from "./loop";
import { getRevenueSummary } from "./tools/get-revenue-summary";
import { listInvoices } from "./tools/list-invoices";
import { searchDocuments } from "./tools/search-documents";
import type { ToolContext } from "./tools/types";

interface DemoAnswer {
  answer: string;
  citations: { kind: "chunk" | "invoice"; id: string; verified: boolean }[];
  citedInvoiceIds: string[];
  retrievedChunkIds: number[];
  toolsUsed: string[];
  demo: true;
}

const text = (s: number | null, currency: string | null): string =>
  s === null ? "n/a" : `${currency ?? "USD"} ${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Answers a question deterministically. Returns null when the question does
 * not match a known shape — the caller then falls back to a canned answer
 * that names the shapes it understands.
 */
export async function demoAnswer(
  question: string,
  ctx: ToolContext,
): Promise<DemoAnswer | null> {
  const q = question.toLowerCase();

  // Totals, counts and averages: one tool, real numbers.
  if (/revenue|total|how much|how many|average|invoiced|sum|value/.test(q)) {
    const summary = await getRevenueSummary.execute(ctx, {});
    const total = text(summary.total_cents, summary.currency);
    const count = summary.invoice_count;
    const evidence = summary.evidence_invoice_ids.slice(0, 3);
    const citations = evidence.map((id) => ({ kind: "invoice" as const, id, verified: true }));
    return {
      answer:
        `Demo answer (from real data): total invoiced value is ${total} across ${count} invoices.` +
        (evidence.length > 0
          ? ` Largest: ${evidence.map((id) => `[${id}]`).join(" ")}`
          : ""),
      citations,
      citedInvoiceIds: evidence,
      retrievedChunkIds: [],
      toolsUsed: ["get_revenue_summary"],
      demo: true,
    };
  }

  // Overdue / open invoices.
  if (/overdue|open invoice|unpaid|outstanding/.test(q)) {
    const result = await listInvoices.execute(ctx, { status: "open", limit: 5 });
    const open = result.invoices;
    const citations = open.map((inv) => ({ kind: "invoice" as const, id: inv.external_id, verified: true }));
    const ids = open.map((inv) => inv.external_id);
    return {
      answer:
        `Demo answer (from real data): ${open.length} invoice(s) are currently open` +
        (open.length > 0
          ? `: ${ids.map((id) => `[${id}]`).join(" ")}`
          : " — nothing is waiting on payment."),
      citations,
      citedInvoiceIds: ids,
      retrievedChunkIds: [],
      toolsUsed: ["list_invoices"],
      demo: true,
    };
  }

  // Payment terms and other corpus questions: the top retrieved chunk.
  if (/payment term|terms|policy|discount|how do we/.test(q)) {
    const search = await searchDocuments.execute(ctx, { query: question, limit: 3 });
    const top = search.chunks[0];
    if (!top) return null;
    return {
      answer:
        `Demo answer (from this organization's documents): ${top.content.slice(0, 280)}` +
        (top.invoice_external_id ? ` [${top.invoice_external_id}]` : ` [chunk:${top.chunk_id}]`),
      citations: [
        {
          kind: top.invoice_external_id ? ("invoice" as const) : ("chunk" as const),
          id: top.invoice_external_id ?? String(top.chunk_id),
          verified: true,
        },
      ],
      citedInvoiceIds: top.invoice_external_id ? [top.invoice_external_id] : [],
      retrievedChunkIds: [top.chunk_id],
      toolsUsed: ["search_documents"],
      demo: true,
    };
  }

  return null;
}

/** The canned answer when no shape matched — still honest about what it can do. */
export function demoFallbackAnswer(): AgentTurnResult & { demo: true } {
  return {
    answer:
      "Demo answer: I'm in demo mode, so I answer deterministically from this tenant's real data. " +
      'Try "what is our total revenue?", "are any invoices overdue?" or "what are our payment terms?".',
    outcome: "ok",
    terminationReason: null,
    steps: 0,
    toolsUsed: [],
    retrievedChunkIds: [],
    citedInvoiceIds: [],
    citations: [],
    verified: false,
    uncited: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    provider: null,
    model: null,
    fallback: false,
    chainAttempts: [],
    demo: true,
  };
}
