import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";
import { citationRepairInstruction, runAgentTurn } from "./loop";
import { PROMPT_VERSION } from "./prompt";
import type { ModelClient } from "./providers";

// D-25 — the citation repair, driven against a stubbed model client so every
// path runs without a network call or an API key: an uncited answer is asked
// once for a revision that names the missing citations, the revision is
// verified with the same deterministic check, and when it is no better the
// original answer stands — the metric stays red rather than the repair
// hiding it.

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

const usage = (input = 10, output = 5) => ({ input_tokens: input, output_tokens: output });

function toolResponse(name: string, input: unknown, tokens = usage()): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: "tu_1", name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: tokens,
  } as unknown as Anthropic.Message;
}

function textResponse(text: string, tokens = usage()): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: tokens,
  } as unknown as Anthropic.Message;
}

function stubModel(responses: Anthropic.Message[]) {
  let calls = 0;
  const model: ModelClient = {
    model: "claude-opus-5",
    provider: "stub",
    createMessage: async () => {
      const next = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return next;
    },
  };
  return { model, callCount: () => calls };
}

const CHUNK = {
  chunk_id: 101,
  source_kind: "document",
  document_id: "d1",
  document_title: "Acme terms",
  invoice_id: null,
  invoice_external_id: null,
  content: "Net 30 from the invoice date.",
  similarity: 0.9,
  vector_rank: 1,
  lexical_rank: 1,
  rrf_score: 0.9,
};

/**
 * Runs the real loop with the embedding round trip and the search RPC
 * stubbed, so the tool runs as written — collectEvidence included.
 */
async function runWithSearch(
  chunks: Record<string, unknown>[],
  model: ModelClient,
  extra: {
    now?: () => number;
    limits?: Partial<{ maxSteps: number; budgetMs: number; tokenCeiling: number }>;
  } = {},
) {
  const realFetch = globalThis.fetch;
  const previousEnv = {
    url: process.env.SUPABASE_URL,
    anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    secret: process.env.EMBED_SHARED_SECRET,
  };
  process.env.SUPABASE_URL = "http://stub.local";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.EMBED_SHARED_SECRET = "secret";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        embeddings: [Array.from({ length: 384 }, () => 0.1)],
        model: "gte-small",
        dimensions: 384,
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const rpcs: RpcCall[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "search_chunks") return { data: chunks, error: null };
      return { data: rpcs.length, error: null };
    },
    from: () => {
      throw new Error("no table tool should run in this test");
    },
  } as unknown as SupabaseClient<Database>;

  try {
    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "corr-repair",
      supabase,
      model,
      now: extra.now,
      limits: extra.limits,
    });
    return { result, rpcs };
  } finally {
    globalThis.fetch = realFetch;
    process.env.SUPABASE_URL = previousEnv.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousEnv.anon;
    process.env.EMBED_SHARED_SECRET = previousEnv.secret;
  }
}

function repairRows(rpcs: RpcCall[]): RpcCall[] {
  return rpcs.filter(
    (r) => r.fn === "log_llm_call" && (r.args.p_tool_args as { kind?: string } | null)?.kind === "citation_repair",
  );
}

describe("the citation repair (D-25)", () => {
  it("repairs an uncited answer exactly once, and uses the verified revision", async () => {
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
      textResponse("Net 30 applies [chunk:101]."),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model);

    expect(result.outcome).toBe("ok");
    expect(result.answer).toBe("Net 30 applies [chunk:101].");
    expect(result.verified).toBe(true);
    expect(result.uncited).toBe(false);
    expect(result.citations).toEqual([{ kind: "chunk", id: "101", verified: true }]);
    // The repair is one extra call, and the turn ends right after it: the
    // model was asked exactly once, never twice.
    expect(callCount()).toBe(3);
    expect(repairRows(rpcs)).toHaveLength(1);
    // The repair counts as a step: one tool round trip plus the repair.
    expect(result.steps).toBe(2);
  });

  it("does not repair an answer that already cites what it retrieved", async () => {
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 applies [chunk:101]."),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model);

    expect(result.answer).toBe("Net 30 applies [chunk:101].");
    expect(result.verified).toBe(true);
    expect(callCount()).toBe(2);
    expect(repairRows(rpcs)).toHaveLength(0);
  });

  it("never repairs an abstention", async () => {
    // The model searched, found nothing, and composed — the loop discards
    // the composition and abstains. The repair must not fire over an answer
    // with nothing to cite.
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "parental leave" }),
      textResponse("Parental leave is six weeks."),
    ]);

    const { result, rpcs } = await runWithSearch([], model);

    expect(result.outcome).toBe("abstained");
    expect(result.answer).toContain("I don't have data on that");
    expect(callCount()).toBe(2);
    expect(repairRows(rpcs)).toHaveLength(0);
  });

  it("keeps the repair inside the step budget", async () => {
    // Two steps allowed: one tool round trip, then the uncited answer, then
    // the repair as the second and final step — the turn ends at the cap
    // with no further call.
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
      textResponse("Net 30 applies [chunk:101]."),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model, {
      limits: { maxSteps: 2 },
    });

    expect(result.steps).toBe(2);
    expect(result.verified).toBe(true);
    expect(callCount()).toBe(3);
    expect(repairRows(rpcs)).toHaveLength(1);
  });

  it("skips the repair when the turn is already out of the token budget", async () => {
    // The final answer's own tokens cross the ceiling; a repair would be a
    // spend the turn no longer has, so it is skipped and the uncited answer
    // stands.
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }, usage(10, 5)),
      textResponse("Net 30 from the invoice date.", usage(10, 5)),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model, {
      limits: { tokenCeiling: 25 },
    });

    expect(result.answer).toBe("Net 30 from the invoice date.");
    expect(result.verified).toBe(false);
    expect(result.uncited).toBe(true);
    expect(callCount()).toBe(2);
    expect(repairRows(rpcs)).toHaveLength(0);
  });

  it("skips the repair when the wall clock is gone", async () => {
    // The clock passes the budget only after the final answer lands, so the
    // loop-top check cannot see it — the repair's own gate has to.
    let ticks = 0;
    const now = () => {
      ticks++;
      return ticks >= 6 ? 60_000 : 0;
    };
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model, {
      now,
      limits: { budgetMs: 30_000 },
    });

    expect(result.answer).toBe("Net 30 from the invoice date.");
    expect(result.verified).toBe(false);
    expect(callCount()).toBe(2);
    expect(repairRows(rpcs)).toHaveLength(0);
  });

  it("audits both steps with the turn's correlation id and prompt version", async () => {
    const { model } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
      textResponse("Net 30 applies [chunk:101]."),
    ]);

    const { rpcs } = await runWithSearch([CHUNK], model);

    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    // Step 0: the tool call. Step 1: the uncited final answer. Step 2: the
    // repair. Both steps of the answer are on the trail.
    expect(calls).toHaveLength(3);
    expect(calls[0].args.p_step_no).toBe(0);
    expect(calls[0].args.p_tool_name).toBe("search_documents");
    expect(calls[1].args.p_step_no).toBe(1);
    expect(calls[1].args.p_tool_name).toBeNull();

    const repair = calls[2];
    expect(repair.args.p_step_no).toBe(2);
    expect(repair.args.p_correlation_id).toBe("corr-repair");
    expect(repair.args.p_prompt_version).toBe(PROMPT_VERSION);
    expect(repair.args.p_outcome).toBe("ok");
    expect(repair.args.p_tool_name).toBeNull();
    expect(repair.args.p_tool_args).toEqual({
      kind: "citation_repair",
      for_step: 1,
      reason: "uncited answer",
    });
    expect(repair.args.p_retrieved_chunk_ids).toEqual([101]);
  });

  it("keeps the original answer when the repair is no better", async () => {
    // The revision is still uncited — the repair tried once and failed, and
    // hiding the bad answer behind a second uncited one would be worse than
    // returning the first.
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "payment terms" }),
      textResponse("Net 30 from the invoice date."),
      textResponse("Still no citation in this revision."),
    ]);

    const { result, rpcs } = await runWithSearch([CHUNK], model);

    expect(result.answer).toBe("Net 30 from the invoice date.");
    expect(result.verified).toBe(false);
    expect(result.uncited).toBe(true);
    expect(result.answer).not.toContain("Still no citation");
    expect(callCount()).toBe(3);
    // The attempt is still on the audit trail — a repair that ran and failed
    // is exactly what an incident reconstruction needs.
    expect(repairRows(rpcs)).toHaveLength(1);
  });
});

describe("citationRepairInstruction", () => {
  it("names the ids the model may cite and forbids invention", () => {
    const text = citationRepairInstruction([12, 34], ["inv_00007"]);
    expect(text).toContain("chunk ids: 12, 34");
    expect(text).toContain("invoice ids: inv_00007");
    expect(text).toContain("[chunk:<id>]");
    expect(text).toContain("[invoice:<external_id>]");
    expect(text).toMatch(/do not invent/i);
  });

  it("names nothing when no ids were retrieved", () => {
    const text = citationRepairInstruction([], []);
    expect(text).not.toContain("Available to cite");
  });
});
