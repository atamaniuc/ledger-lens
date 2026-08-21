import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import {
  HISTORY_TOKEN_BUDGET,
  assembleHistory,
  runAgentTurn,
  type AgentStepEvent,
  type ConversationTurn,
} from "@/features/agent/loop";
import type { ModelClient } from "@/features/agent/providers";
import type { Database } from "@/platform/supabase/database.types";
import { ORG_A } from "./helpers/db";
import { signInBrowser } from "./helpers/auth";
import { localStack } from "./helpers/stack";

// Spec 0013, AC-01: the streaming transport, and the proof that it is a
// transport and not a second decision surface.
//
// The loop-level tests are deterministic: the model is stubbed on BOTH
// transports, the database audit writes are recorded, and the same question
// is run twice — once on the JSON path, once streaming — to assert the same
// tools, the same citations and the same audit rows come out of both. The
// route-level tests then assert the wire contract over HTTP: the JSON path
// still answers with a single JSON body (the eval runner's contract), and
// Accept: text/event-stream produces SSE step events ending in a done event.
// AC-03's unit half — the token budget that drops the oldest turns first —
// is asserted directly against assembleHistory and through the loop.

let apiUrl: string;

test.beforeAll(() => {
  ({ apiUrl } = localStack());
});

// --- loop-level fixtures ----------------------------------------------------

function stubSupabase() {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: rpcs.length, error: null };
    },
    from: () => ({
      select: () => ({
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      }),
    }),
  } as unknown as SupabaseClient<Database>;
  return { supabase, rpcs };
}

const usage = () => ({ input_tokens: 10, output_tokens: 5 });

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function toolResponse(name: string, input: unknown): Anthropic.Message {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "stub-model",
    content: [{ type: "tool_use", id: "tu_1", name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * A stub model that answers identically on both transports: the same message
 * sequence, and a streamMessage that yields the same text as deltas. This is
 * what makes the two-transports comparison exact — the only difference
 * between the runs is the transport.
 */
function bothTransportsModel() {
  const responses = [
    toolResponse("get_revenue_summary", {}),
    textResponse("Net 30 from the invoice date. [invoice:INV-00000]"),
  ];
  let createCalls = 0;
  let streamCalls = 0;
  const client: ModelClient = {
    model: "stub-model",
    provider: "stub",
    createMessage: async () => {
      const next = responses[Math.min(createCalls, responses.length - 1)];
      createCalls++;
      return next;
    },
    async streamMessage() {
      const index = Math.min(streamCalls, responses.length - 1);
      streamCalls++;
      const message = responses[index];
      const text = messageText(message);
      return {
        deltas: (async function* () {
          if (text.length > 0) yield text;
        })(),
        message: Promise.resolve(message),
      };
    },
  };
  return { client, createCalls: () => createCalls, streamCalls: () => streamCalls };
}

// --- AC-01: one loop, two transports ----------------------------------------


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

test.describe("spec 0013 — one loop, two transports", () => {
  test("the same question down both transports yields the same tools, citations and audit rows", async () => {
    // One correlation id for both runs: the audit rows carry it, and the
    // point of the comparison is that every other field is identical.
    const correlationId = "both-transports-shared";
    async function runOnce(stream: boolean) {
      const { supabase, rpcs } = stubSupabase();
      const { client } = bothTransportsModel();
      const events: AgentStepEvent[] = [];
      const result = await runAgentTurn({
        question: "what are our payment terms?",
        orgId: "00000000-0000-4000-8000-000000000001",
        correlationId,
        supabase,
        model: client,
        stream,
        emit: stream ? (event) => events.push(event) : undefined,
        now: () => 0,
      });
      return { result, rpcs, events };
    }

    const json = await runOnce(false);
    const streamed = await runOnce(true);

    // The decision logic did not fork: same answer, same tools, same
    // citations, same verification verdict, same outcome.
    expect(streamed.result.answer).toBe(json.result.answer);
    expect(streamed.result.outcome).toBe(json.result.outcome);
    expect(streamed.result.steps).toBe(json.result.steps);
    expect(streamed.result.toolsUsed).toEqual(json.result.toolsUsed);
    expect(streamed.result.citations).toEqual(json.result.citations);
    expect(streamed.result.verified).toBe(json.result.verified);

    // The audit trail is identical — every llm_calls and audit_log write,
    // in the same order, with the same values. One loop means one trail.
    expect(streamed.rpcs).toEqual(json.rpcs);

    // AC-01: step events arrive before the final answer.
    expect(streamed.events.length).toBeGreaterThan(0);
    const kinds = streamed.events.map((event) => event.type);
    expect(kinds[0]).toBe("step");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("tokens");
  });

  test("the streaming path writes the provider that answered onto the same audit rows", async () => {
    // ADR 0010 visibility holds on the streaming path too: the llm_calls
    // rows name the answering provider/model, and the result surfaces it.
    const { supabase, rpcs } = stubSupabase();
    const { client } = bothTransportsModel();
    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "stream-provider",
      supabase,
      model: client,
      stream: true,
      emit: () => {},
      now: () => 0,
    });

    expect(result.provider).toBe("stub");
    expect(result.model).toBe("stub-model");
    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    for (const call of calls) {
      expect(call.args.p_provider).toBe("stub");
      expect(call.args.p_model).toBe("stub-model");
    }
  });
});

// --- AC-03: bounded history -------------------------------------------------

test.describe("spec 0013 — bounded history", () => {
  const turn = (question: string, answer: string): ConversationTurn => ({ question, answer });

  test("drops the oldest turns first when the budget is exceeded", () => {
    expect(assembleHistory([])).toEqual([]);

    // A single turn that overflows the budget alone is still kept: a
    // follow-up must at least see the turn it follows.
    const huge = turn("q", "a".repeat(HISTORY_TOKEN_BUDGET * 8));
    expect(assembleHistory([huge])).toEqual([huge]);

    const budget = 10;
    const newest = turn("q", "a".repeat(7)); // 2 tokens
    const fits = turn("q", "a".repeat(31)); // 8 tokens → 2 + 8 = 10, exactly on the line
    const overflows = turn("q", "a".repeat(35)); // 9 tokens → 2 + 9 = 11, over

    // The boundary is kept; one step over drops the older turn.
    expect(assembleHistory([fits, newest], budget)).toEqual([fits, newest]);
    expect(assembleHistory([overflows, newest], budget)).toEqual([newest]);
  });

  test("a follow-up sees the prior question and answer in the model's messages", async () => {
    const { supabase } = stubSupabase();
    let received: Anthropic.MessageParam[] = [];
    const model: ModelClient = {
      model: "stub-model",
      provider: "stub",
      createMessage: async (params) => {
        received = params.messages;
        return textResponse("Net 30 from the invoice date.");
      },
    };

    const result = await runAgentTurn({
      question: "and the second one?",
      orgId: ORG_A,
      correlationId: "history-followup",
      supabase,
      model,
      history: [{ question: "what are our payment terms?", answer: "Net 30 from the invoice date." }],
    });

    expect(result.outcome).toBe("ok");
    const text = received
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" | ");
    expect(text).toContain("what are our payment terms?");
    expect(text).toContain("Net 30 from the invoice date.");
    expect(text).toContain("and the second one?");
  });

  test("history over the token budget never reaches the model", async () => {
    const { supabase } = stubSupabase();
    let received: Anthropic.MessageParam[] = [];
    const model: ModelClient = {
      model: "stub-model",
      provider: "stub",
      createMessage: async (params) => {
        received = params.messages;
        return textResponse("ok");
      },
    };

    await runAgentTurn({
      question: "and now?",
      orgId: ORG_A,
      correlationId: "history-bound",
      supabase,
      model,
      historyTokenBudget: 10,
      history: [
        // ~12 tokens alone — older than the budget allows alongside the
        // newest turn, so it must be dropped before the model sees it.
        { question: "oldest", answer: "a".repeat(39) },
        { question: "q", answer: "a".repeat(7) },
      ],
    });

    const text = received
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(" | ");
    expect(text).not.toContain("oldest");
    expect(text).toContain("and now?");
  });
});

// --- the route: wire contract over HTTP -------------------------------------

function parseSse(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const raw of text.split("\n\n")) {
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (data.length === 0) continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // a keep-alive frame is not an event
    }
  }
  return events;
}

test.describe("spec 0013 — the chat route's two transports", () => {
  test("the JSON path still answers with a single JSON body, unchanged", async ({ context, request }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    const res = await context.request.post("/api/agent/chat", {
      data: { question: "what are our payment terms?" },
    });

    // Whatever the deployment answers, it is one JSON document — never a
    // stream. The eval runner and every pre-existing test depend on this.
    expect(res.headers()["content-type"] ?? "").toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.correlation_id).toBeTruthy();

    if (res.status() === 200) {
      // The eval runner's contract, field by field.
      expect(typeof body.answer).toBe("string");
      expect(typeof body.outcome).toBe("string");
      expect(Array.isArray(body.toolsUsed)).toBe(true);
      expect(Array.isArray(body.citations)).toBe(true);
      expect(typeof body.verified).toBe("boolean");
      expect(body.usage).toBeTruthy();
      expect(typeof body.provider).toBe("string");
    } else {
      // A refusal still names itself in JSON (429/402/503), with the fields
      // the acceptance criteria name.
      expect(typeof body.error).toBe("string");
    }
  });

  test("Accept: text/event-stream streams step events and ends with done", async ({ context, request }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    test.setTimeout(120_000);
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    const res = await context.request.post("/api/agent/chat", {
      headers: { accept: "text/event-stream" },
      data: { question: "which invoices are overdue?" },
    });

    const contentType = res.headers()["content-type"] ?? "";
    if (res.status() === 200 && contentType.includes("text/event-stream")) {
      const events = parseSse(await res.text());
      expect(events.length).toBeGreaterThan(0);

      const kinds = events.map((event) => String(event.type));
      const doneIndex = kinds.lastIndexOf("done");
      const errorIndex = kinds.indexOf("error");
      if (doneIndex >= 0) {
        // The turn answered: progressive events precede the final answer.
        expect(doneIndex).toBeGreaterThan(0);
        const done = events[doneIndex] as { result?: { answer?: unknown } };
        expect(typeof done.result?.answer).toBe("string");
      } else {
        // The turn failed mid-stream — on a shared free tier that happens
        // (a provider 429, a cooled-down chain). The transport is still
        // proven: the events parse, and the error event carries the same
        // distinguishable fields the JSON path would have returned.
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        const err = events[errorIndex] as { error?: unknown; correlation_id?: unknown };
        expect(typeof err.error).toBe("string");
      }
    } else {
      // A configured deployment can refuse before the stream starts
      // (429/402/503) — still one JSON body, never a broken stream. An
      // unconfigured deployment 503s the same way.
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      expect(body).toBeTruthy();
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test("the copilot panel parses a streamed response and renders its answer", async ({ page, context, request }) => {
    test.skip(
      !providerConfigured(),
      "no provider configured: the route answers 503 before it reaches this path, by design",
    );
    // The UI half of AC-01, over a real SSE response: the panel's transport
    // must negotiate the stream and turn the done event's result into the
    // answer. (Rendering the intermediate steps is the Streaming story's
    // job — a stubbed body arrives in one chunk, so the intermediate state
    // is batched away; a live stream paints it over time.)
    await signInBrowser(context, request, apiUrl, "alice@acme.test");
    let acceptHeader = "";
    await page.route("**/api/agent/chat", async (route) => {
      acceptHeader = route.request().headers()["accept"] ?? "";
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: [
          "data: " + JSON.stringify({ type: "step", stepNo: 0, tool: "search_documents", args: {} }),
          "data: " + JSON.stringify({ type: "tool_result", stepNo: 0, tool: "search_documents", summary: "3 chunks" }),
          "data: " + JSON.stringify({ type: "tokens", text: "Three invoices are overdue." }),
          "data: " + JSON.stringify({
            type: "done",
            result: {
              correlation_id: "panel-stream",
              answer: "Three invoices are overdue.",
              outcome: "ok",
              terminationReason: null,
              steps: 1,
              toolsUsed: ["search_documents"],
              retrievedChunkIds: [],
              citedInvoiceIds: [],
              citations: [],
              verified: true,
              uncited: false,
              usage: { inputTokens: 10, outputTokens: 5 },
              provider: "stub",
              model: "stub-model",
            },
          }),
          "",
        ].join("\n\n"),
      });
    });

    await page.goto("/dashboard");
    // Asserted before touching the panel so a failure says which thing broke:
    // a redirect back to /login (a session that did not stick) reads very
    // differently from a panel that never rendered, and in a full-suite run
    // the difference was a timeout on `fill` that named neither.
    await expect(page).toHaveURL(/\/dashboard$/);
    const question = page.getByTestId("copilot-question");
    await expect(question).toBeVisible({ timeout: 15_000 });
    await question.fill("which invoices are overdue?");
    await page.getByTestId("copilot-submit").click();

    await expect(page.getByTestId("copilot-answer")).toContainText("Three invoices are overdue.");
    // The request negotiated the stream, not the JSON contract.
    expect(acceptHeader).toContain("text/event-stream");
  });
});
