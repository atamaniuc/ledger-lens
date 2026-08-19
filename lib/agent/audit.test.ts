import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AuditError, logAgentAction, logLlmCall } from "./audit";
import { AGENT_MODEL, MODEL_PRICES, costCents } from "./pricing";

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function stubClient(result: { data?: unknown; error?: { message: string } }) {
  const calls: RpcCall[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: result.data ?? 1, error: result.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { supabase, calls };
}

describe("costCents", () => {
  it("prices a call from the versioned table", () => {
    // 1M input at $5 = 500 cents; 1M output at $25 = 2500 cents.
    expect(costCents("claude-opus-5", 1_000_000, 0)).toBe(500);
    expect(costCents("claude-opus-5", 0, 1_000_000)).toBe(2500);
    expect(costCents("claude-opus-5", 1_000_000, 1_000_000)).toBe(3000);
  });

  it("rounds to the four decimals the column stores", () => {
    const cost = costCents("claude-opus-5", 1_234, 567);
    expect(cost).not.toBeNull();
    expect(String(cost).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it("treats missing token counts as zero", () => {
    expect(costCents("claude-opus-5", null, undefined)).toBe(0);
  });

  it("returns null for a model the table does not know", () => {
    // An accounting gap, not a reason to fail the user's question.
    expect(costCents("some-model-shipped-after-this-table", 1000, 1000)).toBeNull();
  });

  it("prices the model the agent actually runs on", () => {
    expect(MODEL_PRICES[AGENT_MODEL]).toBeDefined();
  });

  it("refuses negative token counts", () => {
    expect(() => costCents("claude-opus-5", -1, 0)).toThrow();
  });
});

describe("logLlmCall", () => {
  const record = {
    orgId: "00000000-0000-4000-8000-000000000001",
    correlationId: "corr-1",
    stepNo: 2,
    model: AGENT_MODEL,
    promptVersion: "v1",
    inputTokens: 1_000_000,
    outputTokens: 0,
    latencyMs: 900,
    toolName: "search_documents",
    toolArgs: { query: "payment terms" },
    retrievedChunkIds: [1, 2, 3],
    outcome: "ok" as const,
  };

  it("sends the computed cost, not the raw tokens alone", async () => {
    const { supabase, calls } = stubClient({ data: 42 });

    const id = await logLlmCall(supabase, record);

    expect(id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe("log_llm_call");
    expect(calls[0].args.p_cost_cents).toBe(500);
    expect(calls[0].args.p_step_no).toBe(2);
    expect(calls[0].args.p_retrieved_chunk_ids).toEqual([1, 2, 3]);
  });

  it("never sends an actor — the database stamps it", async () => {
    const { supabase, calls } = stubClient({});
    await logLlmCall(supabase, record);
    const keys = Object.keys(calls[0].args);
    expect(keys).not.toContain("p_actor_id");
    expect(keys).not.toContain("p_on_behalf_of");
  });

  it("fails the turn when the audit write fails", async () => {
    // "Zero unaudited agent actions" is a PRD counter-metric. Swallowing this
    // would trade that guarantee for one answer.
    const { supabase } = stubClient({ error: { message: "permission denied" } });
    await expect(logLlmCall(supabase, record)).rejects.toThrow(AuditError);
  });
});

describe("logAgentAction", () => {
  it("passes only what the caller is allowed to choose", async () => {
    const { supabase, calls } = stubClient({ data: 7 });

    await logAgentAction(supabase, {
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "corr-1",
      action: "search_documents",
      entity: "chunk",
      entityId: "12",
      details: { query: "net 30" },
    });

    expect(calls[0].fn).toBe("log_agent_action");
    expect(Object.keys(calls[0].args).sort()).toEqual([
      "p_action",
      "p_correlation_id",
      "p_details",
      "p_entity",
      "p_entity_id",
      "p_org_id",
    ]);
  });

  it("fails the turn when the audit write fails", async () => {
    const { supabase } = stubClient({ error: { message: "not a member" } });
    await expect(
      logAgentAction(supabase, {
        orgId: "00000000-0000-4000-8000-000000000002",
        correlationId: "corr-1",
        action: "search_documents",
      }),
    ).rejects.toThrow(AuditError);
  });
});
