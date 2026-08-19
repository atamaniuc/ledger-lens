import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { openAiCompatibleClient } from "./openai-compatible";
import { ModelError } from "./types";

// The translation is the whole risk in this adapter. Everything below asserts
// a specific mistranslation would be caught — most importantly the stop
// reason, because getting that wrong does not error: the agent would answer
// without ever running the tool it just asked for.

const TOOLS = [
  {
    name: "list_invoices",
    description: "List invoices.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
] as unknown as Anthropic.Tool[];

function clientReturning(body: unknown, status = 200) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = openAiCompatibleClient({
    provider: "groq",
    baseUrl: "https://api.groq.com/openai/v1/",
    apiKey: "k",
    model: "llama-3.3-70b-versatile",
    fetchImpl,
  });
  return { client, seen };
}

const ok = (message: unknown, finish = "stop") => ({
  id: "chatcmpl-1",
  model: "llama-3.3-70b-versatile",
  choices: [{ finish_reason: finish, message }],
  usage: { prompt_tokens: 120, completion_tokens: 30 },
});

const call = (params: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) =>
  ({
    model: "ignored",
    max_tokens: 4096,
    system: "You are a copilot.",
    tools: TOOLS,
    messages: [{ role: "user", content: "what did we invoice?" }],
    ...params,
  }) as Anthropic.MessageCreateParamsNonStreaming;

describe("openAiCompatibleClient — the request", () => {
  it("puts the system prompt first and joins the base URL without doubling the slash", async () => {
    const { client, seen } = clientReturning(ok({ content: "hi" }));
    await client.createMessage(call(), { timeoutMs: 5_000 });

    expect(seen[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const messages = seen[0].body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: "You are a copilot." });
    expect(messages[1]).toEqual({ role: "user", content: "what did we invoice?" });
  });

  it("translates a tool definition without reshaping its schema", async () => {
    const { client, seen } = clientReturning(ok({ content: "hi" }));
    await client.createMessage(call(), { timeoutMs: 5_000 });

    expect(seen[0].body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "list_invoices",
          description: "List invoices.",
          parameters: { type: "object", properties: { limit: { type: "number" } } },
        },
      },
    ]);
  });

  it("keeps parallel tool calls in one assistant message", async () => {
    // Splitting them would teach the model that parallel calls are not
    // available here, which is a behaviour change disguised as a translation.
    const { client, seen } = clientReturning(ok({ content: "hi" }));
    await client.createMessage(
      call({
        messages: [
          { role: "user", content: "what did we invoice?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking." },
              { type: "tool_use", id: "a", name: "list_invoices", input: { limit: 2 } },
              { type: "tool_use", id: "b", name: "get_revenue_summary", input: {} },
            ],
          } as Anthropic.MessageParam,
        ],
      }),
      { timeoutMs: 5_000 },
    );

    const messages = seen[0].body.messages as {
      role: string;
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    }[];
    const assistant = messages[2];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Looking.");
    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls?.[0].function.arguments).toBe('{"limit":2}');
  });

  it("splits one Anthropic tool-result turn into one message per result", async () => {
    const { client, seen } = clientReturning(ok({ content: "hi" }));
    await client.createMessage(
      call({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "a", content: '{"rows":[]}' },
              { type: "tool_result", tool_use_id: "b", content: "boom", is_error: true },
            ],
          } as Anthropic.MessageParam,
        ],
      }),
      { timeoutMs: 5_000 },
    );

    const messages = seen[0].body.messages as { role: string; tool_call_id?: string }[];
    expect(messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "a", content: '{"rows":[]}' },
      { role: "tool", tool_call_id: "b", content: "boom" },
    ] as unknown as { role: string; tool_call_id?: string }[]);
  });
});

describe("openAiCompatibleClient — the response", () => {
  it("maps tool_calls to tool_use blocks and to a tool_use stop reason", async () => {
    const { client } = clientReturning(
      ok(
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "list_invoices", arguments: '{"limit":3}' },
            },
          ],
        },
        "tool_calls",
      ),
    );

    const message = await client.createMessage(call(), { timeoutMs: 5_000 });

    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "tool_use", id: "call_1", name: "list_invoices", input: { limit: 3 } },
    ] as unknown as Anthropic.ContentBlock[]);
  });

  it("maps a plain answer to a text block and end_turn", async () => {
    const { client } = clientReturning(ok({ content: "Net 30." }));
    const message = await client.createMessage(call(), { timeoutMs: 5_000 });

    expect(message.stop_reason).toBe("end_turn");
    expect(message.content[0]).toMatchObject({ type: "text", text: "Net 30." });
  });

  it("reports a truncated response as max_tokens", async () => {
    const { client } = clientReturning(ok({ content: "half an ans" }, "length"));
    const message = await client.createMessage(call(), { timeoutMs: 5_000 });
    expect(message.stop_reason).toBe("max_tokens");
  });

  it("renames token counts rather than losing them", async () => {
    // These feed the token ceiling and the cost column; a silent zero here
    // would make an expensive turn look free and unbounded.
    const { client } = clientReturning(ok({ content: "hi" }));
    const message = await client.createMessage(call(), { timeoutMs: 5_000 });
    expect(message.usage).toMatchObject({ input_tokens: 120, output_tokens: 30 });
  });

  it("survives tool arguments that are not valid JSON", async () => {
    // The registry validates every argument with Zod before execution, so a
    // malformed call fails there with something the model can act on. Throwing
    // here would end a turn that still had steps left.
    const { client } = clientReturning(
      ok(
        {
          content: null,
          tool_calls: [
            { id: "c", type: "function", function: { name: "list_invoices", arguments: "{oops" } },
          ],
        },
        "tool_calls",
      ),
    );

    const message = await client.createMessage(call(), { timeoutMs: 5_000 });
    expect(message.content[0]).toMatchObject({ type: "tool_use", input: {} });
  });

  it("treats a tool call with no finish_reason as tool_use anyway", async () => {
    // Not every provider sets finish_reason the way OpenAI does; the presence
    // of a call is the stronger signal.
    const { client } = clientReturning(
      ok(
        {
          content: null,
          tool_calls: [
            { id: "c", type: "function", function: { name: "list_invoices", arguments: "{}" } },
          ],
        },
        undefined,
      ),
    );
    const message = await client.createMessage(call(), { timeoutMs: 5_000 });
    expect(message.stop_reason).toBe("tool_use");
  });

  it("raises a ModelError carrying the status on a rejected request", async () => {
    const { client } = clientReturning({ error: { message: "rate limit reached" } }, 429);

    await expect(client.createMessage(call(), { timeoutMs: 5_000 })).rejects.toThrow(
      /groq returned 429: rate limit reached/,
    );
    await expect(client.createMessage(call(), { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      ModelError,
    );
  });

  it("raises rather than inventing an answer when there are no choices", async () => {
    const { client } = clientReturning({ id: "x", choices: [] });
    await expect(client.createMessage(call(), { timeoutMs: 5_000 })).rejects.toThrow(
      /no choices/,
    );
  });
});
