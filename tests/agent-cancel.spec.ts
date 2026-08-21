import type Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { runAgentTurn } from "@/features/agent/loop";
import type { ModelClient } from "@/features/agent/providers";
import type { Database } from "@/platform/supabase/database.types";
import { signInBrowser } from "./helpers/auth";
import { ORG_A, sql } from "./helpers/db";
import { localStack } from "./helpers/stack";

// Spec 0013, AC-02: cancellation.
//
// The claim has two halves, asserted against the two layers that own them:
//
//   * The loop stops within one step, makes no further provider call, and
//     records the turn as `cancelled` — driven with a model call that never
//     resolves and a request signal that fires mid-call. Deterministic, no
//     provider needed.
//   * The audit lands in the real database as `cancelled` (AC-02's SQL:
//     `select outcome from llm_calls order by id desc limit 1`), both when
//     the loop is driven directly against the real stack and when a browser
//     that asked for a stream simply disconnects mid-turn.

let apiUrl: string;
let anonKey: string;

test.beforeAll(() => {
  ({ apiUrl, anonKey } = localStack());
});

function stubSupabase() {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: rpcs.length, error: null };
    },
    from: () => {
      throw new Error("no tool should run in a cancelled turn");
    },
  } as unknown as SupabaseClient<Database>;
  return { supabase, rpcs };
}

/** A provider call that starts and never answers — the worst case for cancellation. */
function hangingModel() {
  let calls = 0;
  const model: ModelClient = {
    model: "stub-model",
    provider: "stub",
    createMessage: () => {
      calls++;
      return new Promise<Anthropic.Message>(() => {});
    },
  };
  return { model, callCount: () => calls };
}

/** The last llm_calls outcome for one correlation id, or "no-row" after the wait. */
async function pollOutcome(correlationId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await sql<{ outcome: string }[]>`
      select outcome from llm_calls where correlation_id = ${correlationId}
       order by id desc limit 1`;
    if (rows.length > 0) return rows[0].outcome;
    if (Date.now() > deadline) return "no-row";
    await new Promise((r) => setTimeout(r, 500));
  }
}


/** See tests/agent-rate-limit.spec.ts: the route answers 503 before the budget
 * gate and before any model call when nothing is configured, and CI holds no
 * key — so a route-level assertion here is about a configured deployment. */
function providerConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ??
      process.env.GROQ_API_KEY ??
      process.env.NVIDIA_API_KEY ??
      (process.env.LLM_API_KEY && process.env.LLM_BASE_URL ? "generic" : undefined),
  );
}

test.describe("spec 0013 — cancellation (AC-02)", () => {
  test("an aborted request stops the loop within one step and is audited as cancelled", async () => {
    const { supabase, rpcs } = stubSupabase();
    const { model, callCount } = hangingModel();
    const controller = new AbortController();
    const correlationId = `cancel-unit-${Date.now()}`;

    const turn = runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId,
      supabase,
      model,
      signal: controller.signal,
    });

    // Let the first provider call start, then the client walks away.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    const result = await turn;
    expect(result.outcome).toBe("cancelled");
    expect(result.terminationReason).toContain("cancelled");
    // Exactly one call was started — the in-flight one — and the abort
    // stopped the loop before any further call.
    expect(callCount()).toBe(1);

    // The audit names the outcome: a cancelled turn is never recorded as an
    // answer (US-04).
    const outcomes = rpcs
      .filter((r) => r.fn === "log_llm_call")
      .map((r) => r.args.p_outcome);
    expect(outcomes.at(-1)).toBe("cancelled");

    // And nothing else is called after the abort lands.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callCount()).toBe(1);
  });

  test("an abort between steps never starts the next provider call", async () => {
    // The loop checks the signal at every step boundary, so a signal that
    // fires after a step finished still prevents the next call from
    // starting. The stub answers the first call and would answer the second;
    // only the abort decides it never happens.
    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    let calls = 0;
    const model: ModelClient = {
      model: "stub-model",
      provider: "stub",
      createMessage: async () => {
        calls++;
        const next: Anthropic.Message = {
          id: `msg_${calls}`,
          type: "message",
          role: "assistant",
          model: "stub-model",
          content:
            calls === 1
              ? [{ type: "tool_use", id: "tu_1", name: "get_revenue_summary", input: {} }]
              : [{ type: "text", text: "Net 30.", citations: null }],
          stop_reason: calls === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        } as unknown as Anthropic.Message;
        return next;
      },
    };

    // The tool's query resolves on a macrotask, so the abort can land while
    // the step's tool is running — after the first model call, before any
    // second one could be started.
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return { data: rpcs.length, error: null };
      },
      from: () => ({
        select: () => ({
          then: (resolve: (v: unknown) => void) =>
            setTimeout(() => resolve({ data: [], error: null }), 60),
        }),
      }),
    } as unknown as SupabaseClient<Database>;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: `cancel-between-${Date.now()}`,
      supabase,
      model,
      signal: controller.signal,
    });

    // The abort landed while the tool ran; the loop's next boundary stopped
    // the turn before the model would have composed an answer.
    expect(result.outcome).toBe("cancelled");
    expect(calls).toBe(1);
    const outcomes = rpcs
      .filter((r) => r.fn === "log_llm_call")
      .map((r) => r.args.p_outcome);
    expect(outcomes).toContain("cancelled");
  });

  test("a cancelled turn lands in llm_calls as cancelled, against the real database", async () => {
    test.setTimeout(60_000);
    const supabase = createClient<Database>(apiUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase.auth.signInWithPassword({
      email: "alice@acme.test",
      password: "password123",
    });
    if (error) throw new Error(`sign-in failed for alice: ${error.message}`);

    const { model, callCount } = hangingModel();
    const controller = new AbortController();
    const correlationId = `cancel-db-${Date.now()}`;

    const turn = runAgentTurn({
      question: "which invoices are overdue?",
      orgId: ORG_A,
      correlationId,
      supabase,
      model,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await turn;
    expect(result.outcome).toBe("cancelled");

    // AC-02's SQL, over the real rows: the turn's last llm_calls row says
    // cancelled, so the audit trail never claims an answer was delivered.
    expect(await pollOutcome(correlationId)).toBe("cancelled");
    expect(callCount()).toBe(1);
  });

  test("a browser that disconnects mid-stream is audited as cancelled", async ({
    page,
    context,
    request,
  }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    test.setTimeout(300_000);
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    await page.goto("/dashboard");

    // The stack is shared and the free provider is paced by other work, so a
    // single attempt can settle before the abort lands — a turn that skips a
    // cooled-down provider errors in milliseconds. The property under test
    // is stable either way: a disconnect while the turn is actually running
    // is audited as `cancelled`. Each attempt uses a fresh correlation id,
    // and the test passes the moment any attempt observes it — if the
    // route's abort wiring were broken, no attempt ever could.
    let observed = "";
    for (let attempt = 0; attempt < 10 && observed !== "cancelled"; attempt++) {
      const correlationId = `cancel-e2e-${Date.now()}-${attempt}`;
      await page.evaluate(
        async ({ correlationId }) => {
          const controller = new AbortController();
          // Abort after the request reaches the server but before the turn
          // settles: the loop checks the signal before spending, so the
          // disconnect is audited as `cancelled` whatever the provider is
          // doing. The window jitters (the route's gates take ~100-200ms
          // here; a turn that skips a cooled-down provider errors at
          // ~160-250ms), so each attempt picks a delay across it and the
          // retry loop collects enough attempts.
          const delay = 110 + Math.floor(Math.random() * 150);
          setTimeout(() => controller.abort(), delay);
          try {
            const response = await fetch("/api/agent/chat", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "text/event-stream" },
              body: JSON.stringify({
                question: "which invoices are overdue?",
                correlation_id: correlationId,
              }),
              signal: controller.signal,
            });
            if (!response.body) return;
            const reader = response.body.getReader();
            try {
              for (;;) {
                const { done } = await reader.read();
                if (done) break;
              }
            } catch {
              // aborted — the fetch rejects; that is the point.
            }
          } catch {
            // Aborted before the response arrived; the request is still
            // processed server-side, so the poll decides.
          }
        },
        { correlationId },
      );
      observed = await pollOutcome(correlationId);
    }
    expect(observed).toBe("cancelled");
  });
});