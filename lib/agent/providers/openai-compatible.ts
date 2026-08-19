import type Anthropic from "@anthropic-ai/sdk";
import { ModelError, type ModelClient, type ModelRequestOptions } from "./types";

// An adapter from this agent's message shape onto the OpenAI chat-completions
// API, which Groq, NVIDIA NIM, Together, Ollama, vLLM and most others speak.
//
// Written by hand rather than by pulling in the OpenAI SDK: what is needed is
// one POST and two translations, and a second vendor SDK would be a larger
// dependency than the code it replaces.
//
// The translation is the whole file. Everything the loop relies on — parallel
// tool calls in one assistant turn, tool results going back together, a stop
// reason that distinguishes "wants a tool" from "finished" — exists in both
// APIs and is renamed here rather than reimplemented.

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Anthropic content blocks in, OpenAI chat messages out. */
function toOpenAiMessages(
  system: string,
  messages: Anthropic.MessageParam[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      // One assistant turn, however many blocks it held. Splitting it would
      // teach the model that parallel tool calls are not a thing here.
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => (block as Anthropic.TextBlock).text)
        .join("\n");
      const toolCalls = message.content
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const use = block as Anthropic.ToolUseBlock;
          return {
            id: use.id,
            type: "function" as const,
            function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
          };
        });

      out.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // A user turn carrying tool results. Anthropic groups them into one
    // message; OpenAI wants one message per result, each naming its call.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const result = block as Anthropic.ToolResultBlockParam;
        out.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        });
      } else if (block.type === "text") {
        out.push({ role: "user", content: (block as Anthropic.TextBlock).text });
      }
    }
  }

  return out;
}

function toOpenAiTools(tools: Anthropic.Tool[] | undefined) {
  return (tools ?? []).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * `finish_reason` and `stop_reason` name the same three things differently.
 *
 * `tool_calls` maps to `tool_use` because that is what the loop branches on —
 * getting this wrong would not error, it would make the agent answer without
 * ever running the tool it asked for.
 */
function toStopReason(finish: string | undefined, hasToolCalls: boolean): Anthropic.Message["stop_reason"] {
  if (hasToolCalls || finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

function toAnthropicMessage(body: OpenAiResponse, model: string): Anthropic.Message {
  const choice = body.choices?.[0];
  if (!choice) throw new ModelError("the provider returned no choices");

  const toolCalls = choice.message?.tool_calls ?? [];
  const content: Anthropic.ContentBlock[] = [];

  const text = choice.message?.content;
  if (typeof text === "string" && text.trim().length > 0) {
    content.push({ type: "text", text, citations: null } as Anthropic.TextBlock);
  }

  for (const call of toolCalls) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      // Left as an empty object on purpose: the tool registry validates every
      // argument with Zod before execution, so a malformed call fails there
      // with a message the model can act on, rather than throwing here and
      // ending a turn that still has steps left.
      input = {};
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    } as Anthropic.ToolUseBlock);
  }

  return {
    id: body.id ?? `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: body.model ?? model,
    content,
    stop_reason: toStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

/**
 * When the provider says to come back, in milliseconds.
 *
 * Read from the `Retry-After` header first, and from the error text second —
 * Groq's free tier puts "Please try again in 22.5075s" in the message and does
 * not always send the header, and a caller that has to regex an error string
 * is a caller that will not bother.
 */
function retryAfterMs(response: Response, body: OpenAiResponse | null): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000);
  }

  const match = /try again in ([\d.]+)s/i.exec(body?.error?.message ?? "");
  if (match) return Math.ceil(Number(match[1]) * 1000);
  return undefined;
}

export interface OpenAiCompatibleConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function openAiCompatibleClient(config: OpenAiCompatibleConfig): ModelClient {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    model: config.model,
    provider: config.provider,

    async createMessage(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options: ModelRequestOptions,
    ): Promise<Anthropic.Message> {
      const system = typeof params.system === "string" ? params.system : "";

      const response = await doFetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: toOpenAiMessages(system, params.messages),
          tools: toOpenAiTools(params.tools as Anthropic.Tool[] | undefined),
          tool_choice: "auto",
          max_tokens: params.max_tokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      const body = (await response.json().catch(() => null)) as OpenAiResponse | null;

      if (!response.ok) {
        // A 404 here is almost always a model name, not a bad URL, and the
        // provider's own message does not say which variable to change.
        const hint =
          response.status === 404
            ? ` — set ${config.provider.toUpperCase()}_MODEL to a model this account can reach`
            : "";
        throw new ModelError(
          `${config.provider} returned ${response.status}: ${body?.error?.message ?? "no detail"}${hint}`,
          response.status,
          retryAfterMs(response, body),
        );
      }
      if (!body) throw new ModelError(`${config.provider} returned a body that is not JSON`);

      return toAnthropicMessage(body, config.model);
    },
  };
}
