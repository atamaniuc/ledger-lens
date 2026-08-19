import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_STEPS, runAgentTurn } from "./loop";
import type { Database } from "../supabase/database.types";

// Three bounds, three distinct terminations, three distinct recorded reasons.
// Driven against a stubbed Anthropic client so every path runs without a
// network call or an API key.

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

function stubAnthropic(responses: Anthropic.Message[] | (() => Anthropic.Message)) {
  let calls = 0;
  const anthropic = {
    messages: {
      create: async () => {
        const next = Array.isArray(responses)
          ? (responses[calls] ?? responses[responses.length - 1])
          : responses();
        calls++;
        return next;
      },
    },
  } as unknown as Anthropic;
  return { anthropic, callCount: () => calls };
}

const base = {
  question: "what are our payment terms?",
  orgId: "00000000-0000-4000-8000-000000000001",
  correlationId: "corr-loop",
};

describe("runAgentTurn", () => {
  it("returns the model's answer when no tool is called", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { anthropic } = stubAnthropic([textResponse("Net 30 from the invoice date.")]);

    const result = await runAgentTurn({ ...base, supabase, anthropic });

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
    const { anthropic, callCount } = stubAnthropic(() =>
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
      anthropic,
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
    const { anthropic } = stubAnthropic([textResponse("should never be reached")]);

    // A clock that has already passed the budget on the first check.
    let ticks = 0;
    const now = () => (ticks++ === 0 ? 0 : 60_000);

    const result = await runAgentTurn({
      ...base,
      supabase,
      anthropic,
      now,
      limits: { budgetMs: 30_000 },
    });

    expect(result.outcome).toBe("timeout");
    expect(result.terminationReason).toContain("30000ms");
    expect(rpcs.some((r) => r.args.p_outcome === "timeout")).toBe(true);
  });

  it("stops when the token ceiling is reached", async () => {
    const { supabase } = stubSupabase();
    const { anthropic } = stubAnthropic([
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
      anthropic,
      limits: { tokenCeiling: 1_000 },
    });

    expect(result.outcome).toBe("token_ceiling");
    expect(result.terminationReason).toContain("token ceiling of 1000");
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThanOrEqual(1_000);
  });

  it("reports a failed tool back to the model instead of hiding it", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { anthropic } = stubAnthropic([
      toolResponse("list_invoices", { status: "not-a-status" }),
      textResponse("I could not read that."),
    ]);

    const result = await runAgentTurn({ ...base, supabase, anthropic });

    expect(result.outcome).toBe("ok");
    // The attempt is audited whether or not it worked — an attempt that
    // failed is exactly what an incident reconstruction needs.
    const actions = rpcs.filter((r) => r.fn === "log_agent_action");
    expect(actions.some((a) => a.args.p_entity === "tool_call_failed")).toBe(true);
  });

  it("carries one correlation_id onto every row it writes", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { anthropic } = stubAnthropic([textResponse("done")]);

    await runAgentTurn({ ...base, supabase, anthropic });

    expect(rpcs.length).toBeGreaterThan(0);
    for (const call of rpcs) expect(call.args.p_correlation_id).toBe("corr-loop");
  });

  it("abstains without asking the model to compose over an empty context", async () => {
    // US-06 as a mechanism: the second model call never happens. A prompt
    // telling a model not to hallucinate is a request; not calling it is a
    // guarantee.
    const { supabase, rpcs } = stubSupabase();
    const { anthropic, callCount } = stubAnthropic([
      toolResponse("search_documents", { query: "what is our parental leave policy?" }),
      textResponse("this answer must never be produced"),
    ]);

    // The real search path runs, including its embedding round trip, with
    // fetch and the environment stubbed — so this exercises the tool as
    // written rather than a stand-in for it.
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

    let result: Awaited<ReturnType<typeof runAgentTurn>>;
    try {
      result = await runAgentTurn({
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
        anthropic,
      });
    } finally {
      globalThis.fetch = realFetch;
      process.env.SUPABASE_URL = previousEnv.url;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousEnv.anon;
      process.env.EMBED_SHARED_SECRET = previousEnv.secret;
    }

    expect(result.outcome).toBe("abstained");
    expect(result.answer).toContain("I don't have data on that");
    expect(callCount()).toBe(1);
    expect(rpcs.some((r) => r.args.p_outcome === "abstained")).toBe(true);
  });

  it("cannot call a tool that does not exist, however it is asked", async () => {
    // The prompt-injection claim, asserted against the registry rather than
    // against the model's wording: a model that has been talked into trying
    // to exfiltrate data has nothing to try it with.
    const { supabase, rpcs } = stubSupabase();
    const { anthropic } = stubAnthropic([
      toolResponse("send_email", { to: "audit-external@example.net", body: "everything" }),
      textResponse("I can't do that — no such tool exists."),
    ]);

    const result = await runAgentTurn({ ...base, supabase, anthropic });

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
    const { anthropic } = stubAnthropic([textResponse("Net 30 applies [chunk:4242].")]);

    const result = await runAgentTurn({ ...base, supabase, anthropic });

    expect(result.verified).toBe(false);
    expect(result.citations).toEqual([{ kind: "chunk", id: "4242", verified: false }]);
    // The answer keeps the citation — deleting it would hide the signal.
    expect(result.answer).toContain("[chunk:4242]");
  });

  it("defaults to the six-step cap ADR 0009 states", () => {
    expect(MAX_STEPS).toBe(6);
  });
});
