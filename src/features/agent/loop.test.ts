import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_STEPS, runAgentTurn } from "./loop";
import type { ModelClient } from "./providers";
import type { Database } from "@/platform/supabase/database.types";

// Three bounds, three distinct terminations, three distinct recorded reasons.
// Driven against a stubbed model client so every path runs without a network
// call or an API key — and against the same narrow interface every real
// provider implements, so the stub cannot drift from what production uses.

interface StubCall {
  fn: string;
  args: Record<string, unknown>;
}

function stubSupabase() {
  const rpcs: StubCall[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: rpcs.length, error: null };
    },
    from: () => {
      throw new Error("tools should not be reached in this test");
    },
  } as unknown as SupabaseClient<Database>;
  return { supabase, rpcs };
}

const usage = (input = 10, output = 5) => ({ input_tokens: input, output_tokens: output });

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function toolResponse(name: string, input: unknown, tokens = usage()): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "tool_use", id: `tu_${Math.random()}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: tokens,
  } as unknown as Anthropic.Message;
}

function stubModel(responses: Anthropic.Message[] | (() => Anthropic.Message)) {
  let calls = 0;
  const model: ModelClient = {
    model: "claude-opus-5",
    provider: "stub",
    createMessage: async () => {
      const next = Array.isArray(responses)
        ? (responses[calls] ?? responses[responses.length - 1])
        : responses();
      calls++;
      return next;
    },
  };
  return { model, callCount: () => calls };
}

const base = {
  question: "what are our payment terms?",
  orgId: "00000000-0000-4000-8000-000000000001",
  correlationId: "corr-loop",
};

describe("runAgentTurn", () => {
  it("returns the model's answer when no tool is called", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([textResponse("Net 30 from the invoice date.")]);

    const result = await runAgentTurn({ ...base, supabase, model });

    expect(result.outcome).toBe("ok");
    expect(result.answer).toBe("Net 30 from the invoice date.");
    expect(result.terminationReason).toBeNull();
    expect(result.steps).toBe(0);
    // One llm_calls row for the model call, one audit row for the turn.
    expect(rpcs.filter((r) => r.fn === "log_llm_call")).toHaveLength(1);
    expect(rpcs.filter((r) => r.fn === "log_agent_action")).toHaveLength(1);
  });

  it("stops at the step cap and says so", async () => {
    // A model that never stops calling tools is the ordinary failure this
    // bound exists for.
    const { supabase, rpcs } = stubSupabase();
    const { model, callCount } = stubModel(() =>
      toolResponse("get_revenue_summary", {}),
    );

    const result = await runAgentTurn({
      ...base,
      supabase: {
        ...supabase,
        from: () => ({
          select: () => ({
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          }),
        }),
      } as unknown as SupabaseClient<Database>,
      model,
      limits: { maxSteps: 3 },
    });

    expect(result.outcome).toBe("step_cap");
    expect(result.terminationReason).toContain("step cap of 3");
    expect(result.steps).toBe(3);
    expect(callCount()).toBe(3);
    // The terminal row names the bound rather than leaving the last `ok` to
    // stand for a turn that was cut short.
    const outcomes = rpcs
      .filter((r) => r.fn === "log_llm_call")
      .map((r) => r.args.p_outcome);
    expect(outcomes.at(-1)).toBe("step_cap");
  });

  it("stops when the wall-clock budget is gone", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([textResponse("should never be reached")]);

    // A clock that has already passed the budget on the first check.
    let ticks = 0;
    const now = () => (ticks++ === 0 ? 0 : 60_000);

    const result = await runAgentTurn({
      ...base,
      supabase,
      model,
      now,
      limits: { budgetMs: 30_000 },
    });

    expect(result.outcome).toBe("timeout");
    expect(result.terminationReason).toContain("30000ms");
    expect(rpcs.some((r) => r.args.p_outcome === "timeout")).toBe(true);
  });

  it("stops when the token ceiling is reached", async () => {
    const { supabase } = stubSupabase();
    const { model } = stubModel([
      toolResponse("get_revenue_summary", {}, usage(5_000, 5_000)),
      textResponse("never reached"),
    ]);

    const result = await runAgentTurn({
      ...base,
      supabase: {
        ...supabase,
        from: () => ({
          select: () => ({
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          }),
        }),
      } as unknown as SupabaseClient<Database>,
      model,
      limits: { tokenCeiling: 1_000 },
    });

    expect(result.outcome).toBe("token_ceiling");
    expect(result.terminationReason).toContain("token ceiling of 1000");
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThanOrEqual(1_000);
  });

  it("reports a failed tool back to the model instead of hiding it", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([
      toolResponse("list_invoices", { status: "not-a-status" }),
      textResponse("I could not read that."),
    ]);

    const result = await runAgentTurn({ ...base, supabase, model });

    expect(result.outcome).toBe("ok");
    // The attempt is audited whether or not it worked — an attempt that
    // failed is exactly what an incident reconstruction needs.
    const actions = rpcs.filter((r) => r.fn === "log_agent_action");
    expect(actions.some((a) => a.args.p_entity === "tool_call_failed")).toBe(true);
  });

  it("carries one correlation_id onto every row it writes", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([textResponse("done")]);

    await runAgentTurn({ ...base, supabase, model });

    expect(rpcs.length).toBeGreaterThan(0);
    for (const call of rpcs) expect(call.args.p_correlation_id).toBe("corr-loop");
  });

  // The real search path runs, including its embedding round trip, with fetch
  // and the environment stubbed — so these exercise the tool as written
  // rather than a stand-in for it, against a search that finds nothing.
  async function withEmptyRetrieval(
    supabase: SupabaseClient<Database>,
    rpcs: { fn: string; args: Record<string, unknown> }[],
    model: ModelClient,
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

    try {
      return await runAgentTurn({
        ...base,
        supabase: {
          ...supabase,
          rpc: async (fn: string, args: Record<string, unknown>) => {
            rpcs.push({ fn, args });
            // The search RPC finds nothing; the audit RPCs still succeed.
            if (fn === "search_chunks") return { data: [], error: null };
            return { data: rpcs.length, error: null };
          },
        } as unknown as SupabaseClient<Database>,
        model,
      });
    } finally {
      globalThis.fetch = realFetch;
      process.env.SUPABASE_URL = previousEnv.url;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousEnv.anon;
      process.env.EMBED_SHARED_SECRET = previousEnv.secret;
    }
  }

  it("abstains without asking the model to compose over an empty context", async () => {
    // US-06 as a mechanism: the model is never asked to compose. It gets one
    // more step after the first empty search — a compound question can begin
    // with the clause the corpus does not cover — but two empty steps end the
    // turn before any call that would have produced an answer.
    const { supabase, rpcs } = stubSupabase();
    const { model, callCount } = stubModel([
      toolResponse("search_documents", { query: "what is our parental leave policy?" }),
      toolResponse("search_documents", { query: "parental leave" }),
      textResponse("this answer must never be produced"),
    ]);

    const result = await withEmptyRetrieval(supabase, rpcs, model);

    expect(result.outcome).toBe("abstained");
    expect(result.answer).toContain("I don't have data on that");
    // Two tool-selection calls, and never the third that would have composed.
    expect(callCount()).toBe(2);
    expect(result.answer).not.toContain("must never be produced");
    expect(rpcs.some((r) => r.args.p_outcome === "abstained")).toBe(true);
  });

  it("discards an answer composed over an empty context", async () => {
    // The other half of US-06, and the reason the short-circuit is not the
    // only guard: a model that answers instead of searching again has still
    // written over nothing, so what it wrote is thrown away rather than
    // returned. The mechanism is the answer that comes back, not the wording
    // of the one that does not.
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([
      toolResponse("search_documents", { query: "how do I bake sourdough bread?" }),
      textResponse("Sourdough needs a starter and about five hours."),
    ]);

    const result = await withEmptyRetrieval(supabase, rpcs, model);

    expect(result.outcome).toBe("abstained");
    expect(result.answer).not.toContain("Sourdough");
    expect(rpcs.some((r) => r.args.p_outcome === "abstained")).toBe(true);
  });

  it("cannot call a tool that does not exist, however it is asked", async () => {
    // The prompt-injection claim, asserted against the registry rather than
    // against the model's wording: a model that has been talked into trying
    // to exfiltrate data has nothing to try it with.
    const { supabase, rpcs } = stubSupabase();
    const { model } = stubModel([
      toolResponse("send_email", { to: "audit-external@example.net", body: "everything" }),
      textResponse("I can't do that — no such tool exists."),
    ]);

    const result = await runAgentTurn({ ...base, supabase, model });

    expect(result.outcome).toBe("ok");
    const failures = rpcs.filter(
      (r) => r.fn === "log_agent_action" && r.args.p_entity === "tool_call_failed",
    );
    expect(failures).toHaveLength(1);
    expect(String((failures[0].args.p_details as { error: string }).error)).toContain(
      "no tool named send_email",
    );
  });

  it("marks an answer unverified when it cites something never retrieved", async () => {
    const { supabase } = stubSupabase();
    const { model } = stubModel([textResponse("Net 30 applies [chunk:4242].")]);

    const result = await runAgentTurn({ ...base, supabase, model });

    expect(result.verified).toBe(false);
    expect(result.citations).toEqual([{ kind: "chunk", id: "4242", verified: false }]);
    // The answer keeps the citation — deleting it would hide the signal.
    expect(result.answer).toContain("[chunk:4242]");
  });

  it("defaults to the six-step cap ADR 0009 states", () => {
    expect(MAX_STEPS).toBe(6);
  });
});
