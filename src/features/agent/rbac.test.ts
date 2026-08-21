import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/platform/supabase/database.types";
import { runAgentTurn } from "./loop";
import type { ModelClient } from "./providers";
import { RbacRefusedError, assertCanDraft } from "./rbac";
import { runTool } from "./tools";
import type { ToolContext } from "./tools/types";

// D-08: a viewer may read but may not invoke the write-adjacent tool.
// The gate lives in the database (assert_can_draft_tool) and is called from
// the tool registry, so every draft attempt passes through it under the
// caller's own JWT — a viewer is refused, a member/admin is not, and read
// tools never pay the round trip.

const ORG = "00000000-0000-4000-8000-000000000001";

function context(supabase: unknown): ToolContext {
  return {
    supabase: supabase as SupabaseClient<Database>,
    orgId: ORG,
    correlationId: "corr-rbac",
  };
}

describe("assertCanDraft", () => {
  it("resolves when the database allows the caller", async () => {
    const supabase = {
      rpc: async () => ({ data: null, error: null }),
    } as unknown as SupabaseClient<Database>;
    await expect(assertCanDraft(supabase, ORG)).resolves.toBeUndefined();
  });

  it("throws RbacRefusedError when the database refuses the caller", async () => {
    const supabase = {
      rpc: async () => ({ data: null, error: { message: "viewer role cannot use write-adjacent tools" } }),
    } as unknown as SupabaseClient<Database>;
    await expect(assertCanDraft(supabase, ORG)).rejects.toThrow(RbacRefusedError);
  });
});

// A stub of the query chain draft_customer_email builds, so the gate tests
// prove *whether the tool runs* without a database.
function invoiceBuilder(rows: unknown[] | null, error: { message: string } | null = null) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: rows?.[0] ?? null, error }),
  };
  return builder;
}

const INVOICE = {
  id: "00000000-0000-4000-a000-000000000001",
  external_id: "inv_00001",
  customer: "Acme Corp",
  amount_cents: 250_000,
  currency: "USD",
  status: "open",
  issued_at: "2026-01-15",
};

describe("the registry gate", () => {
  it("lets a member run the draft tool", async () => {
    let queried = false;
    const supabase = {
      rpc: async () => {
        // The gate passes; the tool then queries invoices.
        return { data: null, error: null };
      },
      from: () => {
        queried = true;
        return invoiceBuilder([INVOICE]);
      },
    };

    const result = await runTool(
      context(supabase),
      "draft_customer_email",
      { external_id: "inv_00001", purpose: "payment_reminder" },
    ) as { delivery: string };

    expect(queried).toBe(true);
    expect(result.delivery).toBe("not_sent");
  });

  it("refuses a viewer before the tool can query anything", async () => {
    let queried = false;
    const supabase = {
      rpc: async () => ({
        data: null,
        error: { message: "viewer role cannot use write-adjacent tools" },
      }),
      from: () => {
        queried = true;
        throw new Error("the tool must not run for a viewer");
      },
    };

    await expect(
      runTool(context(supabase), "draft_customer_email", {
        external_id: "inv_00001",
        purpose: "payment_reminder",
      }),
    ).rejects.toThrow(RbacRefusedError);
    expect(queried).toBe(false);
  });

  it("never calls the gate for a read tool", async () => {
    let gateCalls = 0;
    const supabase = {
      rpc: async () => {
        gateCalls++;
        return { data: null, error: null };
      },
      from: () => {
        const builder = {
          select: () => builder,
          order: () => builder,
          eq: () => builder,
          ilike: () => builder,
          limit: () => builder,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return builder;
      },
    };

    await runTool(context(supabase), "list_invoices", { status: "paid" });
    expect(gateCalls).toBe(0);
  });
});

describe("the loop under a viewer", () => {
  it("reports the refused draft back to the model and audits the attempt", async () => {
    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        if (fn === "assert_can_draft_tool") {
          return { data: null, error: { message: "viewer role cannot use write-adjacent tools" } };
        }
        return { data: rpcs.length, error: null };
      },
      from: () => {
        throw new Error("a refused tool must never reach the database");
      },
    } as unknown as SupabaseClient<Database>;

    const model: ModelClient = {
      model: "claude-opus-5",
      provider: "stub",
      createMessage: async () => {
        const calls = rpcs.filter((r) => r.fn === "log_llm_call").length;
        if (calls === 0) {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [{
              type: "tool_use",
              id: "tu_rbac",
              name: "draft_customer_email",
              input: { external_id: "inv_00001", purpose: "payment_reminder" },
            }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          } as unknown as Anthropic.Message;
        }
        return {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "I cannot draft that for you.", citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as unknown as Anthropic.Message;
      },
    };

    const result = await runAgentTurn({
      question: "draft a reminder for inv_00001",
      orgId: ORG,
      correlationId: "corr-rbac-loop",
      supabase,
      model,
    });

    expect(result.outcome).toBe("ok");
    // The attempt is audited as a failed tool call, exactly like a missing
    // tool — the refusal is visible in the trail, not hidden from it.
    const failures = rpcs.filter(
      (r) => r.fn === "log_agent_action" && r.args.p_entity === "tool_call_failed",
    );
    expect(failures).toHaveLength(1);
    expect(String((failures[0].args.p_details as { error: string }).error)).toContain(
      "viewer",
    );
  });
});
